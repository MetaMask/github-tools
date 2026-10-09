import { execFileSync, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  extractReleaseSection,
  getPrNumbers,
  replaceReleaseSection,
} from './clean-release-changelog.mts';
import { parseReleaseBranch } from './release-version-utils.mts';
import {
  selectChangelogBaseline,
  type ChangelogBaseline,
} from './update-release-changelog-baseline.mts';

type ProofreadingStatus = 'succeeded' | 'failed';

type ProofreadingResult = {
  status: ProofreadingStatus;
  stage?: string;
};

type ChangelogPrPresentation = {
  title: string;
  body: string;
};

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const CLEANER_PATH = resolve(SCRIPT_DIRECTORY, 'clean-release-changelog.mts');
const PROMPT_PATH = resolve(
  SCRIPT_DIRECTORY,
  '../prompts/auto-changelog-clean-room.md',
);

// All Git and generator children use this environment. The cleaner is
// the sole process allowed to receive the raw LiteLLM key.
const deterministicEnvironment = { ...process.env };
delete deterministicEnvironment.AI_ANALYZER_LITELLM_KEY;

function capture(command: string, args: string[]): string {
  return execFileSync(command, args, {
    encoding: 'utf8',
    env: deterministicEnvironment,
  }).trim();
}

function readChangelogAtRef(ref: string): string {
  mkdirSync('.tmp', { recursive: true });
  const temporaryDirectory = mkdtempSync(
    join('.tmp', 'release-changelog-read-'),
  );
  const temporaryChangelogPath = join(temporaryDirectory, 'CHANGELOG.md');
  const descriptor = openSync(temporaryChangelogPath, 'w');

  try {
    try {
      execFileSync('git', ['show', `${ref}:CHANGELOG.md`], {
        env: deterministicEnvironment,
        stdio: ['ignore', descriptor, 'inherit'],
      });
    } finally {
      closeSync(descriptor);
    }
    return readFileSync(temporaryChangelogPath, 'utf8').trim();
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

function execute(
  command: string,
  args: string[],
  environment = deterministicEnvironment,
): void {
  execFileSync(command, args, { env: environment, stdio: 'inherit' });
}

export function getAutoChangelogCli(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const sourceCli = environment.AUTO_CHANGELOG_CLI;
  if (!sourceCli) {
    throw new Error(
      'AUTO_CHANGELOG_CLI must point to the pinned auto-changelog source CLI',
    );
  }
  return sourceCli;
}

function executeAutoChangelog(args: string[]): void {
  execute('node', [getAutoChangelogCli(), ...args]);
}

function succeeds(command: string, args: string[]): boolean {
  return (
    spawnSync(command, args, {
      env: deterministicEnvironment,
      stdio: 'ignore',
    }).status === 0
  );
}

export function getRemoteBranchSha(branch: string): string | undefined {
  const output = capture('git', [
    'ls-remote',
    '--heads',
    'origin',
    `refs/heads/${branch}`,
  ]);
  const [sha] = output.split(/\s+/u);
  return sha === '' ? undefined : sha;
}

function getRemoteRefSha(ref: string): string | undefined {
  const branch = ref.startsWith('origin/') ? ref.slice('origin/'.length) : ref;
  return getRemoteBranchSha(branch);
}

export function assertRemoteRefUnchanged({
  ref,
  expectedSha,
  description,
}: {
  ref: string;
  expectedSha: string;
  description: string;
}): void {
  const currentSha = getRemoteRefSha(ref);
  if (currentSha !== expectedSha) {
    throw new Error(
      `${description} ${ref} changed during changelog generation; refusing to publish stale output`,
    );
  }
}

function hasReleaseHeading(ref: string, version: string): boolean {
  try {
    const changelog = readChangelogAtRef(ref);
    return (
      changelog.match(
        new RegExp(`^## \\[${version.replaceAll('.', '\\.')}\\]$`, 'gmu'),
      )?.length === 1
    );
  } catch {
    return false;
  }
}

function getStableVersions(): string[] {
  const changelog = readChangelogAtRef('origin/stable');
  return [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\]$/gmu)].flatMap(
    (match) => {
      const version = match[1];
      return version ? [version] : [];
    },
  );
}

function getReleaseBranches() {
  return capture('git', [
    'for-each-ref',
    '--format=%(refname:strip=3)',
    'refs/remotes/origin/release/*',
  ])
    .split(/\r?\n/u)
    .filter(Boolean)
    .flatMap((branchName) => {
      const branch = parseReleaseBranch(branchName);
      return branch ? [branch] : [];
    });
}

function getOpenChangelogPrNumber(
  changelogBranch: string,
  releaseBranch: string,
): string | undefined {
  const number = capture('gh', [
    'pr',
    'list',
    '--head',
    changelogBranch,
    '--base',
    releaseBranch,
    '--state',
    'open',
    '--json',
    'number',
    '--jq',
    '.[0].number // empty',
  ]);
  return number || undefined;
}

function configureGit(authorName: string, authorEmail: string): void {
  execute('git', ['config', 'user.name', authorName]);
  execute('git', ['config', 'user.email', authorEmail]);
  execute('git', ['fetch']);
}

function ensureReleaseBranch(releaseBranch: string): void {
  execute('git', ['checkout', releaseBranch]);
  execute('git', ['reset', '--hard', `origin/${releaseBranch}`]);
}

function determineChangelogBranch(version: string): string {
  const preferredBranch = `release-changelog/${version}`;
  if (getRemoteBranchSha(preferredBranch)) {
    return preferredBranch;
  }

  const fallbackBranch = `${preferredBranch}-fallback`;
  return getRemoteBranchSha(fallbackBranch) ? fallbackBranch : preferredBranch;
}

export function getReviewedCurrentReleaseSection({
  changelogBranch,
  changelogBranchSha,
  releaseBranch,
  version,
  getOpenPrNumber = getOpenChangelogPrNumber,
}: {
  changelogBranch: string;
  changelogBranchSha: string | undefined;
  releaseBranch: string;
  version: string;
  getOpenPrNumber?: typeof getOpenChangelogPrNumber;
}): string | undefined {
  if (!changelogBranchSha) {
    return undefined;
  }

  if (!getOpenPrNumber(changelogBranch, releaseBranch)) {
    throw new Error(
      `${changelogBranch} exists without an open PR to ${releaseBranch}; refusing to overwrite it`,
    );
  }

  try {
    return extractReleaseSection(
      readChangelogAtRef(`origin/${changelogBranch}`),
      version,
    ).section;
  } catch {
    throw new Error(
      `Open changelog branch ${changelogBranch} lacks ${version}; refusing to overwrite it`,
    );
  }
}

export function mergeCurrentReleaseSection({
  changelog,
  currentReleaseSection,
  version,
}: {
  changelog: string;
  currentReleaseSection: string;
  version: string;
}): string {
  const heading = `## [${version}]`;
  if (changelog.includes(heading)) {
    return replaceReleaseSection(changelog, version, currentReleaseSection);
  }

  if (!/^# Changelog\r?\n/u.test(changelog)) {
    throw new Error('CHANGELOG.md must begin with a Changelog heading');
  }

  // Releases follow the preamble and `## [Unreleased]`, newest first.
  const firstRelease = /^## \[(?!Unreleased\])/mu.exec(changelog);
  const lineEnding = changelog.includes('\r\n') ? '\r\n' : '\n';
  const normalizedSection = currentReleaseSection.replaceAll('\n', lineEnding);
  if (!firstRelease) {
    return `${changelog.trimEnd()}${lineEnding}${lineEnding}${normalizedSection}${lineEnding}`;
  }
  return `${changelog.slice(0, firstRelease.index)}${normalizedSection}${lineEnding}${lineEnding}${changelog.slice(firstRelease.index)}`;
}

export function rebuildChangelogBranch({
  changelogBranch,
  releaseBranch,
  baseline,
}: {
  changelogBranch: string;
  releaseBranch: string;
  baseline: ChangelogBaseline;
}): void {
  execute('git', [
    'checkout',
    '-B',
    changelogBranch,
    `origin/${releaseBranch}`,
  ]);
  succeeds('git', ['branch', '--unset-upstream', changelogBranch]);

  if (!succeeds('git', ['cat-file', '-e', `${baseline.ref}:CHANGELOG.md`])) {
    throw new Error(`${baseline.ref} does not contain CHANGELOG.md`);
  }

  execute('git', [
    'restore',
    `--source=${baseline.ref}`,
    '--staged',
    '--worktree',
    '--',
    'CHANGELOG.md',
  ]);

  // Compare through Git so text attributes and core.autocrlf do not turn an
  // exact restore into a false mismatch on Windows worktrees.
  if (
    !succeeds('git', ['diff', '--quiet', baseline.ref, '--', 'CHANGELOG.md'])
  ) {
    throw new Error(`Restored CHANGELOG.md does not match ${baseline.ref}`);
  }
}

function generateChangelog({
  repositoryUrl,
  version,
}: {
  repositoryUrl: string;
  version: string;
}): void {
  const commonArguments = [
    'update',
    '--rc',
    '--repo',
    repositoryUrl,
    '--currentVersion',
    version,
    '--autoCategorize',
    '--useChangelogEntry',
    '--useShortPrLink',
    '--requirePrNumbers',
    '--normalizeToPastTense',
    '--excludeChoreWithoutChangelogEntry',
    '--preventBackfill',
    '--verbose',
  ];

  executeAutoChangelog(commonArguments);
}

export function validateGeneratedReleaseSection(
  changelogContent: string,
  version: string,
  allowDuplicatePrReferences = false,
): void {
  const { section } = extractReleaseSection(changelogContent, version);
  const entries = section.match(/^- .+$/gmu) ?? [];
  if (entries.length === 0) {
    throw new Error(`Generated ## [${version}] section contains no entries`);
  }
  if (entries.some((entry) => getPrNumbers(entry).length === 0)) {
    throw new Error(
      `Generated ## [${version}] section contains an entry without a PR reference`,
    );
  }

  const prNumbers = getPrNumbers(section);
  if (
    !allowDuplicatePrReferences &&
    new Set(prNumbers).size !== prNumbers.length
  ) {
    throw new Error(
      `Generated ## [${version}] section contains duplicate PR references`,
    );
  }
}

export function getChangelogValidationArguments(
  proofreadingStatus: ProofreadingStatus,
): string[] {
  return [
    'validate',
    '--prettier',
    ...(proofreadingStatus === 'succeeded' ? ['--rc'] : []),
  ];
}

function runChangelogValidation(proofreading: ProofreadingResult): void {
  const validationArguments = getChangelogValidationArguments(
    proofreading.status,
  );
  executeAutoChangelog(validationArguments);

  execute('git', ['diff', '--check']);
}

export function writeFailedProofreadingReport(
  reportPath: string,
  error: string,
  stage = 'execution',
): void {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(
    reportPath,
    `${JSON.stringify({ status: 'failed', stage, error }, null, 2)}\n`,
  );
}

function getAiAnalyzerLiteLlmKey(): string | undefined {
  return process.env.AI_ANALYZER_LITELLM_KEY;
}

function getProofreadingFailureStage(reportPath: string): string {
  try {
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as {
      stage?: unknown;
    };
    return typeof report.stage === 'string' ? report.stage : 'execution';
  } catch {
    return 'execution';
  }
}

function runCleanRoomProofread({
  repositoryUrl,
  version,
}: {
  repositoryUrl: string;
  version: string;
}): ProofreadingResult {
  const reportPath = `.tmp/release-changelog-ai/${version}.json`;
  const apiKey = getAiAnalyzerLiteLlmKey();
  if (!apiKey) {
    writeFailedProofreadingReport(
      reportPath,
      'LiteLLM credential is unavailable',
      'authentication',
    );
    return { status: 'failed', stage: 'authentication' };
  }

  try {
    execute(
      'node',
      [
        CLEANER_PATH,
        '--changelog',
        'CHANGELOG.md',
        '--version',
        version,
        '--repository',
        repositoryUrl,
        '--prompt',
        PROMPT_PATH,
        '--report',
        reportPath,
      ],
      { ...deterministicEnvironment, AI_ANALYZER_LITELLM_KEY: apiKey },
    );
    return { status: 'succeeded' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!existsSync(reportPath)) {
      writeFailedProofreadingReport(reportPath, message);
    }
    const stage = getProofreadingFailureStage(reportPath);
    console.warn(
      'AI changelog proofread failed; keeping deterministic generated section.',
    );
    return {
      status: 'failed',
      stage,
    };
  }
}

function getAiFailureWarning(proofreadingStage?: string): string {
  const stageDescription = proofreadingStage
    ? ` during ${proofreadingStage}`
    : '';
  const artifactsUrl =
    process.env.GITHUB_SERVER_URL &&
    process.env.GITHUB_REPOSITORY &&
    process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}#artifacts`
      : undefined;
  const artifactsLink = artifactsUrl
    ? ` [View the proofreading report artifact.](${artifactsUrl})`
    : '';

  return `> AI automation failed${stageDescription}, not proofread. The deterministic changelog generation, reference validation, and changelog lint passed. Review the release section manually before merging.${artifactsLink}`;
}

export function getChangelogPrPresentation({
  version,
  changelogBranch,
  previousVersionRef,
  proofreadingStatus,
  proofreadingStage,
}: {
  version: string;
  changelogBranch: string;
  previousVersionRef: string;
  proofreadingStatus: ProofreadingStatus;
  proofreadingStage?: string;
}): ChangelogPrPresentation {
  let title = `release: ${changelogBranch}`;
  let body = `This PR updates the change log for ${version}.`;
  if (previousVersionRef.toLowerCase() === 'null') {
    body = `${body} (Hotfix - no test plan generated.)`;
  }
  if (proofreadingStatus === 'failed') {
    title = `${title} (AI automation failed, not proofread)`;
    body = `${body}\n\n${getAiFailureWarning(proofreadingStage)}`;
  }
  return { title, body };
}

export function getChangelogPushArguments({
  changelogBranch,
  expectedRemoteSha,
}: {
  changelogBranch: string;
  expectedRemoteSha: string | undefined;
}): string[] {
  const lease = expectedRemoteSha
    ? `--force-with-lease=refs/heads/${changelogBranch}:${expectedRemoteSha}`
    : `--force-with-lease=refs/heads/${changelogBranch}:`;

  return [
    'push',
    lease,
    '--set-upstream',
    'origin',
    `HEAD:refs/heads/${changelogBranch}`,
  ];
}

export function parseUpdateChangelogArguments(argumentsList: string[]): {
  dryRun: boolean;
  positionalArguments: string[];
} {
  return {
    dryRun: argumentsList.includes('--dry-run'),
    positionalArguments: argumentsList.filter(
      (argument) => argument !== '--dry-run',
    ),
  };
}

export function pushChangelogBranch({
  changelogBranch,
  expectedRemoteSha,
}: {
  changelogBranch: string;
  expectedRemoteSha: string | undefined;
}): void {
  try {
    if (expectedRemoteSha) {
      // The changelog branch is rebuilt from the target on every rerun, so its
      // history may change. The lease preserves any concurrent human or bot edit.
      execute(
        'git',
        getChangelogPushArguments({ changelogBranch, expectedRemoteSha }),
      );
    } else {
      // Creation must fail if another actor won the race. Updating a PR after
      // a rejected creation push could associate unverified branch content.
      execute(
        'git',
        getChangelogPushArguments({ changelogBranch, expectedRemoteSha }),
      );
    }
  } catch (error) {
    if (expectedRemoteSha) {
      throw new Error(
        `${changelogBranch} changed after this run began; refusing to overwrite it`,
        { cause: error },
      );
    }
    throw new Error(
      `Failed to create ${changelogBranch}; it may have been created concurrently`,
      { cause: error },
    );
  }
}

function createOrUpdateChangelogPr({
  changelogBranch,
  releaseBranch,
  presentation,
}: {
  changelogBranch: string;
  releaseBranch: string;
  presentation: ChangelogPrPresentation;
}): void {
  const prNumber = getOpenChangelogPrNumber(changelogBranch, releaseBranch);
  if (prNumber) {
    execute('gh', [
      'pr',
      'edit',
      prNumber,
      '--title',
      presentation.title,
      '--body',
      presentation.body,
    ]);
    return;
  }

  execute('gh', [
    'pr',
    'create',
    '--draft',
    '--title',
    presentation.title,
    '--body',
    presentation.body,
    '--base',
    releaseBranch,
    '--head',
    changelogBranch,
  ]);
}

function commitAndPushChangelog({
  version,
  previousVersionRef,
  changelogBranch,
  releaseBranch,
  expectedRemoteSha,
  proofreading,
  assertSourcesUnchanged,
}: {
  version: string;
  previousVersionRef: string;
  changelogBranch: string;
  releaseBranch: string;
  expectedRemoteSha: string | undefined;
  proofreading: ProofreadingResult;
  assertSourcesUnchanged: () => void;
}): void {
  const unexpectedChanges = capture('git', [
    'status',
    '--porcelain',
    '--untracked-files=no',
  ])
    .split(/\r?\n/u)
    .filter(Boolean)
    .filter((line) => !line.endsWith('CHANGELOG.md'));
  if (unexpectedChanges.length > 0) {
    throw new Error(
      `Refusing to commit unexpected tracked changes:\n${unexpectedChanges.join('\n')}`,
    );
  }

  execute('git', ['add', '--', 'CHANGELOG.md']);
  const changesCommitted = !succeeds('git', [
    'diff',
    '--cached',
    '--quiet',
    '--',
    'CHANGELOG.md',
  ]);
  if (changesCommitted) {
    const suffix =
      previousVersionRef.toLowerCase() === 'null'
        ? ' (hotfix - no test plan)'
        : '';
    execute('git', [
      'commit',
      '-m',
      `update changelog for ${version}${suffix}`,
    ]);
  } else if (
    succeeds('git', ['diff', '--quiet', `origin/${releaseBranch}`, 'HEAD'])
  ) {
    console.log('Changelog branch and release branch are already in sync.');
    return;
  }

  assertSourcesUnchanged();
  pushChangelogBranch({ changelogBranch, expectedRemoteSha });
  createOrUpdateChangelogPr({
    changelogBranch,
    releaseBranch,
    presentation: getChangelogPrPresentation({
      version,
      changelogBranch,
      previousVersionRef,
      proofreadingStatus: proofreading.status,
      ...(proofreading.stage ? { proofreadingStage: proofreading.stage } : {}),
    }),
  });
}

function main(): void {
  const { dryRun, positionalArguments } = parseUpdateChangelogArguments(
    process.argv.slice(2),
  );
  const [
    releaseBranch,
    platform = 'extension',
    repositoryUrl,
    previousVersionRef = 'null',
    changelogBranchInput = '',
    versionInput = '',
  ] = positionalArguments;
  if (!releaseBranch || !repositoryUrl) {
    throw new Error(
      'Usage: update-release-changelog.mts [--dry-run] <release-branch> [platform] <repository-url> [previous-version-ref] [changelog-branch] [version]',
    );
  }

  const parsedReleaseBranch = parseReleaseBranch(releaseBranch);
  const version = versionInput || parsedReleaseBranch?.version;
  if (!version) {
    throw new Error(
      `Release branch ${releaseBranch} does not match a supported release branch name and no version was provided`,
    );
  }

  configureGit(
    process.env.GIT_AUTHOR_NAME ?? 'metamaskbot',
    process.env.GIT_AUTHOR_EMAIL ?? 'metamaskbot@users.noreply.github.com',
  );
  execute('git', ['fetch', 'origin', releaseBranch]);
  execute('git', ['fetch', 'origin', 'stable']);
  execute('git', [
    'fetch',
    '--prune',
    'origin',
    '+refs/heads/release/*:refs/remotes/origin/release/*',
  ]);
  ensureReleaseBranch(releaseBranch);
  const targetReleaseSha = capture('git', [
    'rev-parse',
    `origin/${releaseBranch}`,
  ]);

  const changelogBranch =
    changelogBranchInput || determineChangelogBranch(version);
  const changelogBranchSha = getRemoteBranchSha(changelogBranch);
  if (changelogBranchSha) {
    execute('git', ['fetch', 'origin', changelogBranch]);
  }

  const baseline = selectChangelogBaseline({
    version,
    releaseBranch,
    dependencies: {
      hasReleaseHeading,
      getStableVersions,
      getReleaseBranches,
    },
  });
  console.log(
    `Using ${baseline.kind} changelog baseline ${baseline.ref} for ${baseline.version}.`,
  );

  const baselineSha = capture('git', ['rev-parse', baseline.ref]);
  if (!targetReleaseSha || !baselineSha) {
    throw new Error('Unable to resolve the selected target or baseline SHA');
  }

  const reviewedCurrentReleaseSection =
    baseline.kind === 'target'
      ? undefined
      : getReviewedCurrentReleaseSection({
          changelogBranch,
          changelogBranchSha,
          releaseBranch,
          version,
        });

  rebuildChangelogBranch({ changelogBranch, releaseBranch, baseline });
  if (reviewedCurrentReleaseSection) {
    writeFileSync(
      'CHANGELOG.md',
      mergeCurrentReleaseSection({
        changelog: readFileSync('CHANGELOG.md', 'utf8'),
        currentReleaseSection: reviewedCurrentReleaseSection,
        version,
      }),
    );
  }
  console.log(`Generating changelog for ${platform} ${version}.`);
  generateChangelog({ repositoryUrl, version });
  // A generator duplicate is repairable by the clean-room step, but a missing
  // PR reference is never safe to send to it or commit.
  validateGeneratedReleaseSection(
    readFileSync('CHANGELOG.md', 'utf8'),
    version,
    true,
  );

  const proofreading = runCleanRoomProofread({ repositoryUrl, version });
  // The fallback must still meet the final one-reference-per-PR contract.
  validateGeneratedReleaseSection(
    readFileSync('CHANGELOG.md', 'utf8'),
    version,
  );
  runChangelogValidation(proofreading);
  if (dryRun) {
    // Preflight the same source snapshots used for publication, but leave all
    // commits, remote branches, and pull requests unchanged.
    assertRemoteRefUnchanged({
      ref: `origin/${releaseBranch}`,
      expectedSha: targetReleaseSha,
      description: 'Target release branch',
    });
    assertRemoteRefUnchanged({
      ref: baseline.ref,
      expectedSha: baselineSha,
      description: 'Selected baseline',
    });
    if (reviewedCurrentReleaseSection && changelogBranchSha) {
      assertRemoteRefUnchanged({
        ref: `origin/${changelogBranch}`,
        expectedSha: changelogBranchSha,
        description: 'Reviewed changelog branch',
      });
    }
    console.log(
      `Dry run passed for ${releaseBranch}; no commit, push, or PR update was performed.`,
    );
    return;
  }
  commitAndPushChangelog({
    version,
    previousVersionRef,
    changelogBranch,
    releaseBranch,
    expectedRemoteSha: changelogBranchSha,
    proofreading,
    assertSourcesUnchanged: () => {
      assertRemoteRefUnchanged({
        ref: `origin/${releaseBranch}`,
        expectedSha: targetReleaseSha,
        description: 'Target release branch',
      });
      assertRemoteRefUnchanged({
        ref: baseline.ref,
        expectedSha: baselineSha,
        description: 'Selected baseline',
      });
      if (reviewedCurrentReleaseSection && changelogBranchSha) {
        assertRemoteRefUnchanged({
          ref: `origin/${changelogBranch}`,
          expectedSha: changelogBranchSha,
          description: 'Reviewed changelog branch',
        });
      }
    },
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
