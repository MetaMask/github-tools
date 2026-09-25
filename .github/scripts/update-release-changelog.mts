import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  extractReleaseSection,
  getPrNumbers,
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

function capture(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: 'utf8' }).trim();
}

function captureRaw(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: 'utf8' });
}

function execute(command: string, args: string[]): void {
  execFileSync(command, args, { stdio: 'inherit' });
}

function succeeds(command: string, args: string[]): boolean {
  return spawnSync(command, args, { stdio: 'ignore' }).status === 0;
}

function getRemoteBranchSha(branch: string): string | undefined {
  const output = capture('git', ['ls-remote', '--heads', 'origin', branch]);
  const [sha] = output.split(/\s+/u);
  return sha === '' ? undefined : sha;
}

function getRemoteRefSha(ref: string): string | undefined {
  const branch = ref.startsWith('origin/') ? ref.slice('origin/'.length) : ref;
  return getRemoteBranchSha(branch);
}

function assertRemoteRefUnchanged({
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
    const changelog = capture('git', ['show', `${ref}:CHANGELOG.md`]);
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
  const changelog = capture('git', ['show', 'origin/stable:CHANGELOG.md']);
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

function rebuildChangelogBranch({
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

  const expectedChangelog = captureRaw('git', [
    'show',
    `${baseline.ref}:CHANGELOG.md`,
  ]);
  const restoredChangelog = readFileSync('CHANGELOG.md', 'utf8');
  if (restoredChangelog !== expectedChangelog) {
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
  const sourceCli = process.env.AUTO_CHANGELOG_CLI;
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

  if (sourceCli) {
    execute('node', [sourceCli, ...commonArguments]);
    return;
  }

  if (succeeds('yarn', ['run', '--silent', 'update-changelog', '--help'])) {
    execute('yarn', [
      'update-changelog',
      '--repo',
      repositoryUrl,
      '--currentVersion',
      version,
    ]);
    return;
  }

  console.warn(
    'No update-changelog script found; using legacy auto-changelog invocation.',
  );
  execute('yarn', ['auto-changelog', ...commonArguments]);
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

function runChangelogValidation(): void {
  if (succeeds('yarn', ['run', '--silent', 'lint:changelog:rc', '--help'])) {
    execute('yarn', ['lint:changelog:rc']);
  } else if (
    succeeds('yarn', ['run', '--silent', 'lint:changelog', '--help'])
  ) {
    execute('yarn', ['lint:changelog', '--rc']);
  } else {
    throw new Error('No changelog validation script is available');
  }

  execute('git', ['diff', '--check']);
}

function writeFailedProofreadingReport(
  reportPath: string,
  error: string,
): void {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(
    reportPath,
    `${JSON.stringify(
      { status: 'failed', stage: 'execution', error },
      null,
      2,
    )}\n`,
  );
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
  try {
    execute('node', [
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
    ]);
    return { status: 'succeeded' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!existsSync(reportPath)) {
      writeFailedProofreadingReport(reportPath, message);
    }
    console.warn(
      'AI changelog proofread failed; keeping deterministic generated section.',
    );
    return {
      status: 'failed',
      stage: getProofreadingFailureStage(reportPath),
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

function pushChangelogBranch({
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
      execute('git', [
        'push',
        `--force-with-lease=refs/heads/${changelogBranch}:${expectedRemoteSha}`,
        '--set-upstream',
        'origin',
        `HEAD:refs/heads/${changelogBranch}`,
      ]);
    } else {
      execute('git', ['push', '--set-upstream', 'origin', changelogBranch]);
    }
  } catch (error) {
    if (expectedRemoteSha) {
      throw new Error(
        `${changelogBranch} changed after this run began; refusing to overwrite it`,
        { cause: error },
      );
    }
    if (!getRemoteBranchSha(changelogBranch)) {
      throw error;
    }
    console.warn(`No changes pushed to existing branch ${changelogBranch}.`);
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
  const [
    releaseBranch,
    platform = 'extension',
    repositoryUrl,
    previousVersionRef = 'null',
    changelogBranchInput = '',
    versionInput = '',
  ] = process.argv.slice(2);
  if (!releaseBranch || !repositoryUrl) {
    throw new Error(
      'Usage: update-release-changelog.mts <release-branch> [platform] <repository-url> [previous-version-ref] [changelog-branch] [version]',
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
    changelogBranch,
    changelogBranchSha,
    dependencies: {
      hasReleaseHeading,
      getOpenChangelogPrNumber,
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

  rebuildChangelogBranch({ changelogBranch, releaseBranch, baseline });
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
  runChangelogValidation();
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
    },
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
