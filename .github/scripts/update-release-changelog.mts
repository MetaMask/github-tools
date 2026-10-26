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
  getEntryLines,
  getNewReleaseEntriesSection,
  getPrNumbers,
  getReleaseVersions,
  hasSingleReleaseHeading,
  mergeCurrentReleaseSection,
  mergeNewReleaseEntries,
  normalizeRepositoryPrLinks,
  parseReleaseHeadingVersion,
  replaceReleaseSection,
  restoreGeneratedCategories,
  splitLines,
} from './release-section.mts';
import { compareSemver, parseReleaseBranch } from './release-version-utils.mts';
import { getEnvironmentWithoutAiKey } from './shared/environment.mts';
import { writeReport } from './shared/report.mts';
import {
  removeNewerReleases,
  selectChangelogBaseline,
  type ChangelogBaseline,
} from './update-release-changelog-baseline.mts';

type ProofreadingStatus = 'succeeded' | 'failed' | 'no-new-prs' | 'unchanged';

type ProofreadingResult = {
  status: ProofreadingStatus;
  stage?: string;
  presentInVersions?: string[];
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
const deterministicEnvironment = getEnvironmentWithoutAiKey();

/**
 * Runs a command and returns its trimmed standard output.
 *
 * @param command - The executable to run.
 * @param args - The command arguments.
 * @returns The trimmed standard output.
 */
function capture(command: string, args: string[]): string {
  return execFileSync(command, args, {
    encoding: 'utf8',
    env: deterministicEnvironment,
    // `git rev-list` over the extension's history is over the 1 MiB default.
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

/**
 * Reads `CHANGELOG.md` as committed at a Git ref.
 *
 * @param ref - The Git ref to read from.
 * @returns The trimmed changelog content.
 */
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

/**
 * Reads one version's release section from the changelog at a Git ref.
 *
 * @param ref - The Git ref to read from.
 * @param version - The release version.
 * @returns The release section.
 */
function readReleaseSectionAtRef(ref: string, version: string): string {
  return extractReleaseSection(readChangelogAtRef(ref), version).section;
}

/**
 * Runs a command with inherited output, throwing when it fails.
 *
 * @param command - The executable to run.
 * @param args - The command arguments.
 * @param environment - The child environment, which by default omits the AI key.
 */
function execute(
  command: string,
  args: string[],
  environment = deterministicEnvironment,
): void {
  execFileSync(command, args, { env: environment, stdio: 'inherit' });
}

/**
 * Returns the path of the installed auto-changelog CLI.
 *
 * @param environment - The environment to read `AUTO_CHANGELOG_CLI` from.
 * @returns The CLI path.
 */
export function getAutoChangelogCli(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const cli = environment.AUTO_CHANGELOG_CLI;
  if (!cli) {
    throw new Error(
      'AUTO_CHANGELOG_CLI must point to the installed auto-changelog CLI',
    );
  }
  return cli;
}

/**
 * Runs the auto-changelog CLI.
 *
 * @param args - The CLI arguments.
 */
function executeAutoChangelog(args: string[]): void {
  execute('node', [getAutoChangelogCli(), ...args]);
}

/**
 * Runs a command and reports whether it exited with status 0.
 *
 * @param command - The executable to run.
 * @param args - The command arguments.
 * @returns `true` when the command succeeded.
 */
function succeeds(command: string, args: string[]): boolean {
  return (
    spawnSync(command, args, {
      env: deterministicEnvironment,
      stdio: 'ignore',
    }).status === 0
  );
}

/**
 * Looks up a branch tip on origin without fetching it.
 *
 * @param branch - The branch name without the `origin/` prefix.
 * @returns The SHA, or `undefined` when the branch does not exist.
 */
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

/**
 * Looks up the origin tip of a ref given with or without the `origin/` prefix.
 *
 * @param ref - The ref to look up.
 * @returns The SHA, or `undefined` when the branch does not exist.
 */
function getRemoteRefSha(ref: string): string | undefined {
  const branch = ref.startsWith('origin/') ? ref.slice('origin/'.length) : ref;
  return getRemoteBranchSha(branch);
}

/**
 * Throws when a remote ref moved since it was read, so stale output is never
 * published.
 *
 * @param options0 - The options.
 * @param options0.ref - The ref to check, with or without `origin/`.
 * @param options0.expectedSha - The SHA read when the run began.
 * @param options0.description - A label for the ref, used in the error message.
 */
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

/**
 * Reports whether a ref's changelog has exactly one heading for a version.
 *
 * @param ref - The Git ref to read.
 * @param version - The version to look for.
 * @returns `true` when exactly one heading exists; `false` also when the
 * changelog cannot be read.
 */
function hasReleaseHeading(ref: string, version: string): boolean {
  try {
    return hasSingleReleaseHeading(readChangelogAtRef(ref), version);
  } catch {
    return false;
  }
}

/**
 * Lists the versions that have a heading in the `stable` changelog.
 *
 * @returns The versions.
 */
function getStableVersions(): string[] {
  return getReleaseVersions(readChangelogAtRef('origin/stable'));
}

/**
 * Lists the release branches that exist on origin.
 *
 * @returns The parsed release branches.
 */
function getReleaseBranches() {
  // strip=3 drops `refs/remotes/origin/`, leaving `release/X.Y.Z`.
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

/**
 * Finds the open changelog PR from a changelog branch to a release branch.
 *
 * @param changelogBranch - The PR head branch.
 * @param releaseBranch - The PR base branch.
 * @returns The PR number and title, or `undefined` when no PR is open.
 */
function getOpenChangelogPr(
  changelogBranch: string,
  releaseBranch: string,
): { number: string; title: string } | undefined {
  const output = capture('gh', [
    'pr',
    'list',
    '--head',
    changelogBranch,
    '--base',
    releaseBranch,
    '--state',
    'open',
    '--json',
    'number,title',
    '--jq',
    '.[0] // empty',
  ]);
  if (!output) {
    return undefined;
  }
  const { number, title } = JSON.parse(output) as {
    number: number;
    title: string;
  };
  return { number: String(number), title };
}

/**
 * Finds the number of the open changelog PR from a changelog branch to a
 * release branch.
 *
 * @param changelogBranch - The PR head branch.
 * @param releaseBranch - The PR base branch.
 * @returns The PR number, or `undefined` when no PR is open.
 */
function getOpenChangelogPrNumber(
  changelogBranch: string,
  releaseBranch: string,
): string | undefined {
  return getOpenChangelogPr(changelogBranch, releaseBranch)?.number;
}

/**
 * Sets the commit identity and fetches origin.
 *
 * @param authorName - The commit author and committer name.
 * @param authorEmail - The commit author and committer email.
 */
function configureGit(authorName: string, authorEmail: string): void {
  execute('git', ['config', 'user.name', authorName]);
  execute('git', ['config', 'user.email', authorEmail]);
  execute('git', ['fetch']);
}

/**
 * Checks out the release branch and discards any stale local state so the work
 * starts from the remote tip.
 *
 * @param releaseBranch - The release branch name.
 */
function ensureReleaseBranch(releaseBranch: string): void {
  execute('git', ['checkout', releaseBranch]);
  execute('git', ['reset', '--hard', `origin/${releaseBranch}`]);
}

/**
 * Chooses the changelog branch name: the preferred name, or its `-fallback`
 * variant when only that one exists on origin.
 *
 * @param version - The version being released.
 * @returns The changelog branch name.
 */
function determineChangelogBranch(version: string): string {
  const preferredBranch = `release-changelog/${version}`;
  if (getRemoteBranchSha(preferredBranch)) {
    return preferredBranch;
  }

  const fallbackBranch = `${preferredBranch}-fallback`;
  return getRemoteBranchSha(fallbackBranch) ? fallbackBranch : preferredBranch;
}

/**
 * Strips trailing spaces and tabs, which `git diff --check` rejects and the
 * generator never emits.
 *
 * @param text - The text to clean.
 * @returns The text without trailing whitespace on any line.
 */
function trimTrailingWhitespace(text: string): string {
  return text.replace(/[ \t]+$/gmu, '');
}

/**
 * Returns the release section a reviewer may have edited on an open changelog
 * branch. Refuses to continue when the branch has no open PR or lacks the
 * section, so reviewed work is never overwritten.
 *
 * @param options0 - The options.
 * @param options0.changelogBranch - The changelog branch name.
 * @param options0.changelogBranchSha - The branch tip on origin, or `undefined`
 * when the branch does not exist.
 * @param options0.releaseBranch - The target release branch.
 * @param options0.version - The version being released.
 * @param options0.allowMissingOpenPr - Whether a branch without an open PR is
 * ignored instead of refused. A target baseline already holds the merged
 * section, so only an open PR carries reviewed work worth keeping.
 * @param options0.isUpdaterOnlyBranch - Reports whether the branch holds only
 * the updater's own commits, so a failed PR creation can be recovered by
 * regenerating it.
 * @param options0.getOpenPrNumber - Looks up the open PR number; replaceable in
 * tests.
 * @returns The reviewed section, or `undefined` when the branch does not exist.
 */
export function getReviewedCurrentReleaseSection({
  changelogBranch,
  changelogBranchSha,
  releaseBranch,
  version,
  allowMissingOpenPr = false,
  isUpdaterOnlyBranch = () => false,
  getOpenPrNumber = getOpenChangelogPrNumber,
}: {
  changelogBranch: string;
  changelogBranchSha: string | undefined;
  releaseBranch: string;
  version: string;
  allowMissingOpenPr?: boolean;
  isUpdaterOnlyBranch?: () => boolean;
  getOpenPrNumber?: typeof getOpenChangelogPrNumber;
}): string | undefined {
  if (!changelogBranchSha) {
    return undefined;
  }

  if (!getOpenPrNumber(changelogBranch, releaseBranch)) {
    if (allowMissingOpenPr || isUpdaterOnlyBranch()) {
      return undefined;
    }
    throw new Error(
      `${changelogBranch} exists without an open PR to ${releaseBranch}; refusing to overwrite it`,
    );
  }

  try {
    return trimTrailingWhitespace(
      readReleaseSectionAtRef(`origin/${changelogBranch}`, version),
    );
  } catch {
    throw new Error(
      `Open changelog branch ${changelogBranch} lacks ${version}; refusing to overwrite it`,
    );
  }
}

/**
 * Recreates the changelog branch from the release branch with `CHANGELOG.md`
 * restored from the baseline, and verifies the restore is exact.
 *
 * @param options0 - The options.
 * @param options0.changelogBranch - The changelog branch name.
 * @param options0.releaseBranch - The target release branch.
 * @param options0.baseline - The baseline whose changelog is restored.
 */
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
  // Branching from a remote ref sets tracking; this is expected to fail when
  // none was set.
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

/**
 * Runs auto-changelog and returns its standard error. Stderr is buffered so the
 * verbose skip diagnostics can be parsed.
 *
 * @param args - The CLI arguments.
 * @returns The captured standard error.
 */
function executeAutoChangelogCapturingDiagnostics(args: string[]): string {
  const result = spawnSync('node', [getAutoChangelogCli(), ...args], {
    env: deterministicEnvironment,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'inherit', 'pipe'],
  });
  process.stderr.write(result.stderr);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `auto-changelog exited with status ${String(result.status)}`,
    );
  }
  return result.stderr;
}

/**
 * Extracts the PRs the generator skipped because an earlier release already
 * lists them.
 *
 * @param diagnostics - The generator's verbose standard error.
 * @returns The distinct PR numbers.
 */
export function getHistoricalSkippedPrNumbers(diagnostics: string): string[] {
  const prNumbers = [
    ...diagnostics.matchAll(
      /\[auto-changelog\] skipped pr=(\d+) reason=historical-pr/gu,
    ),
  ].flatMap((match) => (match[1] ? [match[1]] : []));
  return [...new Set(prNumbers)];
}

/**
 * Extracts the commits the generator accepted for each PR.
 *
 * @param diagnostics - The generator's verbose standard error.
 * @returns The accepted commit SHAs by canonical PR number.
 */
export function getAcceptedPrCommits(
  diagnostics: string,
): Map<string, string[]> {
  const commitsByPr = new Map<string, string[]>();
  for (const match of diagnostics.matchAll(
    /\[auto-changelog\] commit=([0-9a-f]{40}) accepted source-pr=\d+ canonical-pr=(\d+)/gu,
  )) {
    const [, commit = '', prNumber = ''] = match;
    commitsByPr.set(prNumber, [...(commitsByPr.get(prNumber) ?? []), commit]);
  }
  return commitsByPr;
}

/**
 * Finds the other released versions whose sections mention any of the PRs.
 *
 * @param changelog - The full changelog text.
 * @param prNumbers - The PR numbers to look for.
 * @param excludedVersion - The version whose section is ignored.
 * @param repositoryUrl - The repository's GitHub URL, so its long PR links
 * count as references.
 * @returns The matching versions, oldest first.
 */
export function findReleaseVersionsContainingPrs(
  changelog: string,
  prNumbers: readonly string[],
  excludedVersion: string,
  repositoryUrl?: string,
): string[] {
  const wanted = new Set(prNumbers);
  const versions = new Set<string>();
  let currentVersion: string | undefined;
  const normalizedChangelog = repositoryUrl
    ? normalizeRepositoryPrLinks(changelog, repositoryUrl)
    : changelog;
  for (const line of splitLines(normalizedChangelog)) {
    const headingVersion = parseReleaseHeadingVersion(line);
    if (headingVersion) {
      currentVersion = headingVersion;
    } else if (
      currentVersion &&
      currentVersion !== excludedVersion &&
      getPrNumbers(line).some((prNumber) => wanted.has(prNumber))
    ) {
      versions.add(currentVersion);
    }
  }
  return [...versions].sort(compareSemver);
}

/**
 * Reports whether a version's section has no entries.
 *
 * @param changelogContent - The full changelog text.
 * @param version - The version to check.
 * @returns `true` when the section has no entries.
 */
export function isReleaseSectionEmpty(
  changelogContent: string,
  version: string,
): boolean {
  const { section } = extractReleaseSection(changelogContent, version);
  return getEntryLines(section).length === 0;
}

/**
 * Runs auto-changelog to generate the release section.
 *
 * @param options0 - The options.
 * @param options0.repositoryUrl - The GitHub repository URL.
 * @param options0.version - The version being released.
 * @returns The PR numbers the generator skipped because an earlier release
 * lists them, and the commits it accepted for each PR.
 */
function generateChangelog({
  repositoryUrl,
  version,
}: {
  repositoryUrl: string;
  version: string;
}): {
  skippedPrNumbers: string[];
  acceptedCommitsByPr: Map<string, string[]>;
} {
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
    // Verbose output carries the skip diagnostics parsed after the run.
    '--verbose',
  ];

  const diagnostics = executeAutoChangelogCapturingDiagnostics(commonArguments);
  return {
    skippedPrNumbers: getHistoricalSkippedPrNumbers(diagnostics),
    acceptedCommitsByPr: getAcceptedPrCommits(diagnostics),
  };
}

/**
 * Throws unless the section has entries that each carry a PR reference and,
 * unless allowed, no PR appears twice.
 *
 * @param changelogContent - The full changelog text.
 * @param version - The version whose section is checked.
 * @param allowDuplicatePrReferences - Whether repeated PR references are
 * tolerated, because the proofreader can repair them.
 */
export function validateGeneratedReleaseSection(
  changelogContent: string,
  version: string,
  allowDuplicatePrReferences = false,
): void {
  const { section } = extractReleaseSection(changelogContent, version);
  const entries = getEntryLines(section);
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

/**
 * Builds the `auto-changelog validate` arguments for a proofreading outcome.
 *
 * @param proofreadingStatus - The proofreading outcome.
 * @param version - The version being released. Passed explicitly because an
 * OTA branch's `package.json` still carries the previous native version.
 * @returns The CLI arguments.
 */
export function getChangelogValidationArguments(
  proofreadingStatus: ProofreadingStatus,
  version: string,
): string[] {
  return [
    'validate',
    '--prettier',
    '--currentVersion',
    version,
    ...(proofreadingStatus === 'succeeded' ? ['--rc'] : []),
  ];
}

/**
 * Throws a clear error when a release section has no entries, instead of the
 * validator's generic one.
 *
 * @param changelogContent - The full changelog text.
 * @param version - The version whose section is checked.
 */
export function assertReleaseSectionHasEntries(
  changelogContent: string,
  version: string,
): void {
  if (isReleaseSectionEmpty(changelogContent, version)) {
    throw new Error(
      `## [${version}] has no entries. Add entries to the changelog PR; every push to the release branch fails until the section has one.`,
    );
  }
}

/**
 * Validates the changelog with auto-changelog and checks the diff for
 * whitespace errors.
 *
 * @param proofreading - The proofreading outcome.
 * @param version - The version being released.
 */
function runChangelogValidation(
  proofreading: ProofreadingResult,
  version: string,
): void {
  // The validator rejects a release with no entries, which is the expected
  // state here until a human edits the draft PR.
  if (proofreading.status !== 'no-new-prs') {
    assertReleaseSectionHasEntries(
      readFileSync('CHANGELOG.md', 'utf8'),
      version,
    );
    executeAutoChangelog(
      getChangelogValidationArguments(proofreading.status, version),
    );
  }

  execute('git', ['diff', '--check']);
}

/**
 * Records a failed proofreading run in the report file.
 *
 * @param reportPath - The report file path.
 * @param error - The failure message.
 * @param stage - The stage that failed.
 */
export function writeFailedProofreadingReport(
  reportPath: string,
  error: string,
  stage = 'execution',
): void {
  writeReport(reportPath, { status: 'failed', stage, error });
}

/**
 * Reads the LiteLLM key from the process environment.
 *
 * @returns The key, or `undefined` when it is not set.
 */
function getAiAnalyzerLiteLlmKey(): string | undefined {
  return process.env.AI_ANALYZER_LITELLM_KEY;
}

/**
 * Reads the failed stage from the proofreader's report.
 *
 * @param reportPath - The report file path.
 * @returns The stage, or `execution` when the report is missing or unreadable.
 */
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

/**
 * Runs the clean-room proofreader on the generated section, keeping the
 * deterministic section when it fails.
 *
 * @param options0 - The options.
 * @param options0.repositoryUrl - The GitHub repository URL.
 * @param options0.version - The version being released.
 * @returns The proofreading outcome.
 */
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

/**
 * Builds the PR warning for a release that has no brand new PRs.
 *
 * @param version - The version being released.
 * @param presentInVersions - The earlier versions that already list the
 * cherry-picked PRs.
 * @returns The warning as a Markdown quote.
 */
export function getNoNewPrsWarning(
  version: string,
  presentInVersions: readonly string[],
): string {
  const cherryPicks =
    presentInVersions.length > 0
      ? `, there are only cherry-picks that were already present in ${presentInVersions.join(', ')}`
      : '';
  return `> There are no brand new PRs in ${version}${cherryPicks}. Please decide how you want to handle this and edit the changelog manually.`;
}

/**
 * Builds the PR warning for a failed proofreading run.
 *
 * @param proofreadingStage - The stage that failed.
 * @returns The warning as a Markdown quote.
 */
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

const AI_FAILURE_TITLE_SUFFIX = ' (AI automation failed, not proofread)';

// A later run folds reviewer commits into its own commit, so only this marker
// shows that the whole section was generated and its proofreading failed.
const UNPROOFREAD_TRAILER_KEY = 'Changelog-Proofread';
const UNPROOFREAD_TRAILER = `${UNPROOFREAD_TRAILER_KEY}: failed`;

// Records the release tip a run generated from, so a later run can tell a PR
// a reviewer deleted from one that merged after the last run.
const GENERATED_THROUGH_TRAILER_KEY = 'Changelog-Generated-Through';

type ChangelogBranchCommit = {
  authorEmail: string;
  subject: string;
  unproofread?: boolean;
  generatedThrough?: string;
};

/**
 * Decides whether an existing PR's title and body are left as they are. A run
 * that adds nothing never rewrites them, and a later success only proofreads
 * the new entries, so it cannot clear a failure marker from an earlier run,
 * unless that run proofread the whole section again.
 *
 * @param options0 - The options.
 * @param options0.existingTitle - The open PR's current title.
 * @param options0.proofreadingStatus - The proofreading outcome of this run.
 * @param options0.replacesWholeSection - Whether this run regenerated and
 * proofread the whole section instead of only new entries.
 * @returns `true` when the PR must not be edited.
 */
export function shouldKeepChangelogPrPresentation({
  existingTitle,
  proofreadingStatus,
  replacesWholeSection = false,
}: {
  existingTitle: string;
  proofreadingStatus: ProofreadingStatus;
  replacesWholeSection?: boolean;
}): boolean {
  return (
    proofreadingStatus === 'unchanged' ||
    (proofreadingStatus === 'succeeded' &&
      !replacesWholeSection &&
      existingTitle.endsWith(AI_FAILURE_TITLE_SUFFIX))
  );
}

/**
 * Reports whether every commit is this updater's own, so none carries a
 * reviewer's work.
 *
 * @param options0 - The options.
 * @param options0.version - The version being released.
 * @param options0.authorEmail - The updater's commit author email.
 * @param options0.commits - The commits the changelog branch has over the
 * release branch.
 * @returns `true` when all commits are the updater's.
 */
export function hasOnlyUpdaterCommits({
  version,
  authorEmail,
  commits,
}: {
  version: string;
  authorEmail: string;
  commits: ChangelogBranchCommit[];
}): boolean {
  return commits.every(
    (commit) =>
      commit.authorEmail === authorEmail &&
      commit.subject === `update changelog for ${version}`,
  );
}

/**
 * Decides whether an open changelog PR can be regenerated from scratch: an
 * earlier AI failure left it marked as not proofread, and its only change is
 * this updater's own commit, so no reviewer edit can be lost.
 *
 * @param options0 - The options.
 * @param options0.title - The open PR's title.
 * @param options0.version - The version being released.
 * @param options0.authorEmail - The updater's commit author email.
 * @param options0.commits - The commits the changelog branch has over the
 * release branch.
 * @returns `true` when the PR is unproofread and untouched by anyone else.
 */
export function isUntouchedUnproofreadChangelogPr({
  title,
  version,
  authorEmail,
  commits,
}: {
  title: string;
  version: string;
  authorEmail: string;
  commits: ChangelogBranchCommit[];
}): boolean {
  return (
    title.endsWith(AI_FAILURE_TITLE_SUFFIX) &&
    commits.length === 1 &&
    commits[0]?.unproofread === true &&
    hasOnlyUpdaterCommits({ version, authorEmail, commits })
  );
}

/**
 * Lists the commits a changelog branch has over its release branch.
 *
 * @param changelogBranch - The changelog branch name.
 * @param releaseBranch - The target release branch.
 * @returns Each commit's author email, subject, whether it carries the
 * unproofread marker, and the release tip it was generated through, newest
 * commit first.
 */
export function getChangelogBranchCommits(
  changelogBranch: string,
  releaseBranch: string,
): ChangelogBranchCommit[] {
  const trailer = (key: string): string => `%(trailers:key=${key},valueonly)`;
  return capture('git', [
    'log',
    `--format=%ae%x09%s%x09${trailer(UNPROOFREAD_TRAILER_KEY)}%x09${trailer(GENERATED_THROUGH_TRAILER_KEY)}%x1e`,
    `origin/${releaseBranch}..origin/${changelogBranch}`,
  ])
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [authorEmail = '', subject = '', proofread = '', through = ''] =
        record.split('\t');
      const generatedThrough = through.trim();
      return {
        authorEmail,
        subject,
        unproofread: proofread.trim() === 'failed',
        ...(/^[0-9a-f]{40}$/u.test(generatedThrough)
          ? { generatedThrough }
          : {}),
      };
    });
}

/**
 * Finds the PRs an earlier run already generated that a reviewer has since
 * removed from the section: every commit of the PR is reachable from the
 * release tip that run generated through, yet the PR is not in the section.
 *
 * @param options0 - The options.
 * @param options0.acceptedCommitsByPr - The commits the generator accepted for
 * each PR in this run.
 * @param options0.generatedThrough - The release tip the last run generated
 * through.
 * @param options0.existingPrNumbers - The PRs the reviewed section lists.
 * @param options0.listReachableCommits - Lists the commits reachable from a
 * ref; replaceable in tests.
 * @returns The deleted PR numbers; empty when the tip cannot be read.
 */
export function getDeletedPrNumbers({
  acceptedCommitsByPr,
  generatedThrough,
  existingPrNumbers,
  listReachableCommits = (ref) =>
    capture('git', ['rev-list', ref]).split(/\r?\n/u),
}: {
  acceptedCommitsByPr: ReadonlyMap<string, readonly string[]>;
  generatedThrough: string;
  existingPrNumbers: ReadonlySet<string>;
  listReachableCommits?: (ref: string) => string[];
}): Set<string> {
  let reachable: Set<string>;
  try {
    reachable = new Set(listReachableCommits(generatedThrough));
  } catch {
    return new Set();
  }
  return new Set(
    [...acceptedCommitsByPr].flatMap(([prNumber, commits]) =>
      !existingPrNumbers.has(prNumber) &&
      commits.every((commit) => reachable.has(commit))
        ? [prNumber]
        : [],
    ),
  );
}

/**
 * Builds the changelog PR title and body for the run's outcome.
 *
 * @param options0 - The options.
 * @param options0.version - The version being released.
 * @param options0.changelogBranch - The changelog branch name.
 * @param options0.proofreadingStatus - The proofreading outcome.
 * @param options0.proofreadingStage - The stage that failed, if any.
 * @param options0.presentInVersions - The earlier versions that already list the
 * cherry-picked PRs.
 * @returns The PR title and body.
 */
export function getChangelogPrPresentation({
  version,
  changelogBranch,
  proofreadingStatus,
  proofreadingStage,
  presentInVersions = [],
}: {
  version: string;
  changelogBranch: string;
  proofreadingStatus: ProofreadingStatus;
  proofreadingStage?: string;
  presentInVersions?: readonly string[];
}): ChangelogPrPresentation {
  let title = `release: ${changelogBranch}`;
  let body = `This PR updates the change log for ${version}.`;
  if (proofreadingStatus === 'failed') {
    title = `${title}${AI_FAILURE_TITLE_SUFFIX}`;
    body = `${body}\n\n${getAiFailureWarning(proofreadingStage)}`;
  }
  if (proofreadingStatus === 'no-new-prs') {
    title = `${title} (no new PRs, manual edit required)`;
    body = `${body}\n\n${getNoNewPrsWarning(version, presentInVersions)}`;
  }
  return { title, body };
}

/**
 * Builds the `git push` arguments, leased to the branch tip read at the start
 * of the run. An empty lease value requires that the branch doesn't exist yet.
 *
 * @param options0 - The options.
 * @param options0.changelogBranch - The changelog branch name.
 * @param options0.expectedRemoteSha - The branch tip read at the start, or
 * `undefined` when the branch must not exist yet.
 * @returns The `git push` arguments.
 */
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

/**
 * Splits `--dry-run` from the positional arguments.
 *
 * @param argumentsList - The command-line arguments.
 * @returns The dry-run flag and the remaining positional arguments.
 */
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

/**
 * Force-pushes the changelog branch with a lease and explains a lost race.
 *
 * @param options0 - The options.
 * @param options0.changelogBranch - The changelog branch name.
 * @param options0.expectedRemoteSha - The branch tip read at the start, or
 * `undefined` when the branch must not exist yet.
 */
export function pushChangelogBranch({
  changelogBranch,
  expectedRemoteSha,
}: {
  changelogBranch: string;
  expectedRemoteSha: string | undefined;
}): void {
  try {
    // The branch is rebuilt on every rerun, so history may change. The lease
    // protects a concurrent human or bot edit; with no expected SHA the push
    // must create the branch and fails if another actor already did.
    execute(
      'git',
      getChangelogPushArguments({ changelogBranch, expectedRemoteSha }),
    );
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

/**
 * Reports whether the remote changelog branch already has this run's
 * `CHANGELOG.md`. Pushing anyway would only replace the commit with one that
 * differs by the release branch's other files, which can dismiss approvals and
 * rerun CI on the open PR.
 *
 * @param changelogBranch - The changelog branch name.
 * @param expectedRemoteSha - The branch tip read at the start of the run.
 * @returns `true` when the remote branch is at the expected tip and its
 * `CHANGELOG.md` matches `HEAD`'s.
 */
export function hasSameChangelogAsRemoteBranch(
  changelogBranch: string,
  expectedRemoteSha: string,
): boolean {
  const remoteRef = `origin/${changelogBranch}`;
  try {
    return (
      capture('git', ['rev-parse', remoteRef]) === expectedRemoteSha &&
      capture('git', ['rev-parse', 'HEAD:CHANGELOG.md']) ===
        capture('git', ['rev-parse', `${remoteRef}:CHANGELOG.md`])
    );
  } catch {
    return false;
  }
}

/**
 * Edits the open changelog PR, or creates a draft one when none is open.
 *
 * @param options0 - The options.
 * @param options0.changelogBranch - The PR head branch.
 * @param options0.releaseBranch - The PR base branch.
 * @param options0.presentation - The PR title and body.
 * @param options0.proofreadingStatus - The proofreading outcome of this run.
 * @param options0.replacesWholeSection - Whether this run proofread the whole
 * section again.
 */
function createOrUpdateChangelogPr({
  changelogBranch,
  releaseBranch,
  presentation,
  proofreadingStatus,
  replacesWholeSection,
}: {
  changelogBranch: string;
  releaseBranch: string;
  presentation: ChangelogPrPresentation;
  proofreadingStatus: ProofreadingStatus;
  replacesWholeSection: boolean;
}): void {
  const existingPr = getOpenChangelogPr(changelogBranch, releaseBranch);
  if (existingPr) {
    if (
      shouldKeepChangelogPrPresentation({
        existingTitle: existingPr.title,
        proofreadingStatus,
        replacesWholeSection,
      })
    ) {
      return;
    }
    execute('gh', [
      'pr',
      'edit',
      existingPr.number,
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

/**
 * Commits `CHANGELOG.md`, then pushes the branch and creates or updates the PR.
 * Does nothing when the branch already matches the release branch.
 *
 * @param options0 - The options.
 * @param options0.version - The version being released.
 * @param options0.changelogBranch - The changelog branch name.
 * @param options0.releaseBranch - The target release branch.
 * @param options0.expectedRemoteSha - The changelog branch tip read at the start,
 * or `undefined` when it does not exist.
 * @param options0.proofreading - The proofreading outcome.
 * @param options0.replacesWholeSection - Whether this run proofread the whole
 * section again.
 * @param options0.markUnproofread - Whether the commit records that the whole
 * section was generated and its proofreading failed.
 * @param options0.generatedThrough - The release tip the commit was generated
 * from.
 * @param options0.assertSourcesUnchanged - Throws when a source ref moved during
 * the run.
 */
function commitAndPushChangelog({
  version,
  changelogBranch,
  releaseBranch,
  expectedRemoteSha,
  proofreading,
  replacesWholeSection,
  markUnproofread,
  generatedThrough,
  assertSourcesUnchanged,
}: {
  version: string;
  changelogBranch: string;
  releaseBranch: string;
  expectedRemoteSha: string | undefined;
  proofreading: ProofreadingResult;
  replacesWholeSection: boolean;
  markUnproofread: boolean;
  generatedThrough: string;
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
    const trailers = [
      `${GENERATED_THROUGH_TRAILER_KEY}: ${generatedThrough}`,
      ...(markUnproofread ? [UNPROOFREAD_TRAILER] : []),
    ];
    execute('git', [
      'commit',
      '-m',
      `update changelog for ${version}`,
      '-m',
      trailers.join('\n'),
    ]);
  } else {
    console.log('Changelog branch and release branch are already in sync.');
    return;
  }

  assertSourcesUnchanged();
  if (
    expectedRemoteSha &&
    hasSameChangelogAsRemoteBranch(changelogBranch, expectedRemoteSha)
  ) {
    console.log(
      `origin/${changelogBranch} already has this content; not pushing.`,
    );
  } else {
    pushChangelogBranch({ changelogBranch, expectedRemoteSha });
  }
  createOrUpdateChangelogPr({
    changelogBranch,
    releaseBranch,
    proofreadingStatus: proofreading.status,
    replacesWholeSection,
    presentation: getChangelogPrPresentation({
      version,
      changelogBranch,
      proofreadingStatus: proofreading.status,
      ...(proofreading.stage ? { proofreadingStage: proofreading.stage } : {}),
      ...(proofreading.presentInVersions
        ? { presentInVersions: proofreading.presentInVersions }
        : {}),
    }),
  });
}

/**
 * Updates the changelog PR for a release branch, or only checks that it could
 * with `--dry-run`.
 */
function main(): void {
  const { dryRun, positionalArguments } = parseUpdateChangelogArguments(
    process.argv.slice(2),
  );
  const [
    releaseBranch,
    platform = 'extension',
    repositoryUrl,
    changelogBranchInput = '',
    versionInput = '',
  ] = positionalArguments;
  if (!releaseBranch || !repositoryUrl) {
    throw new Error(
      'Usage: update-release-changelog.mts [--dry-run] <release-branch> [platform] <repository-url> [changelog-branch] [version]',
    );
  }

  const parsedReleaseBranch = parseReleaseBranch(releaseBranch);
  const version = versionInput || parsedReleaseBranch?.version;
  if (!version) {
    throw new Error(
      `Release branch ${releaseBranch} does not match a supported release branch name and no version was provided`,
    );
  }

  const readChangelog = () => readFileSync('CHANGELOG.md', 'utf8');
  const writeChangelog = (content: string) =>
    writeFileSync('CHANGELOG.md', content);
  const readCurrentReleaseSection = () =>
    extractReleaseSection(readChangelog(), version).section;
  const writeCurrentReleaseSection = (section: string) =>
    writeChangelog(replaceReleaseSection(readChangelog(), version, section));

  const authorEmail =
    process.env.GIT_AUTHOR_EMAIL ?? 'metamaskbot@users.noreply.github.com';
  configureGit(process.env.GIT_AUTHOR_NAME ?? 'metamaskbot', authorEmail);
  // The proofreader checks commits against origin/main.
  for (const branch of [releaseBranch, 'stable', 'main']) {
    execute('git', ['fetch', 'origin', branch]);
  }
  // Every release branch is a candidate predecessor for the baseline.
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

  // Once the changelog PR has merged, the release branch holds the section.
  const existingTargetReleaseSection = hasReleaseHeading(
    `origin/${releaseBranch}`,
    version,
  )
    ? trimTrailingWhitespace(
        readReleaseSectionAtRef(`origin/${releaseBranch}`, version),
      )
    : undefined;

  const reviewedCurrentReleaseSection = getReviewedCurrentReleaseSection({
    changelogBranch,
    changelogBranchSha,
    releaseBranch,
    version,
    allowMissingOpenPr: baseline.kind === 'target',
    isUpdaterOnlyBranch: () =>
      hasOnlyUpdaterCommits({
        version,
        authorEmail,
        commits: getChangelogBranchCommits(changelogBranch, releaseBranch),
      }),
  });

  // An unproofread PR nobody has edited is regenerated whole, so a transient
  // AI failure does not leave its entries unproofread for good.
  const openChangelogPr = reviewedCurrentReleaseSection
    ? getOpenChangelogPr(changelogBranch, releaseBranch)
    : undefined;
  const regenerateWholeSection =
    openChangelogPr !== undefined &&
    isUntouchedUnproofreadChangelogPr({
      title: openChangelogPr.title,
      version,
      authorEmail,
      commits: getChangelogBranchCommits(changelogBranch, releaseBranch),
    });
  const preservedReviewedSection = regenerateWholeSection
    ? undefined
    : reviewedCurrentReleaseSection;

  if (regenerateWholeSection) {
    console.log(
      `Open changelog PR for ${version} is unproofread and unedited; proofreading the whole section again.`,
    );
  } else if (reviewedCurrentReleaseSection) {
    console.log(
      `Preserving reviewed ${version} section from open changelog branch origin/${changelogBranch}.`,
    );
  }

  rebuildChangelogBranch({ changelogBranch, releaseBranch, baseline });
  writeChangelog(removeNewerReleases(readChangelog(), version));
  if (preservedReviewedSection) {
    writeChangelog(
      mergeCurrentReleaseSection({
        changelog: readChangelog(),
        currentReleaseSection: preservedReviewedSection,
        version,
      }),
    );
  }
  console.log(`Generating changelog for ${platform} ${version}.`);
  const { skippedPrNumbers, acceptedCommitsByPr } = generateChangelog({
    repositoryUrl,
    version,
  });

  // Lines already on the release branch, or reviewed in the open changelog PR,
  // are never reworded; only newly generated PRs go to the proofreader.
  const preservedSection =
    preservedReviewedSection ?? existingTargetReleaseSection;
  const generatedSection = readCurrentReleaseSection();
  // A PR the last run generated but the reviewer removed stays removed.
  const generatedThrough = preservedReviewedSection
    ? getChangelogBranchCommits(changelogBranch, releaseBranch).find(
        (commit) => commit.generatedThrough,
      )?.generatedThrough
    : undefined;
  const deletedPrNumbers =
    preservedReviewedSection && generatedThrough
      ? getDeletedPrNumbers({
          acceptedCommitsByPr,
          generatedThrough,
          existingPrNumbers: new Set(getPrNumbers(preservedReviewedSection)),
        })
      : undefined;
  const newEntriesSection = preservedSection
    ? getNewReleaseEntriesSection({
        existingSection: preservedSection,
        generatedSection,
        version,
        repositoryUrl,
        ...(deletedPrNumbers ? { deletedPrNumbers } : {}),
      })
    : generatedSection;

  if (preservedSection) {
    writeCurrentReleaseSection(newEntriesSection ?? preservedSection);
  }

  let proofreading: ProofreadingResult;
  // Checked before `unchanged`: a later push to such a release finds nothing
  // new either, and must keep asking for the manual edit instead of failing.
  if (isReleaseSectionEmpty(readChangelog(), version)) {
    // A hotfix or OTA release may start with no PRs, or only cherry-picks that
    // an earlier release already lists; the draft PR asks a human to write the
    // section.
    const presentInVersions = findReleaseVersionsContainingPrs(
      readChangelog(),
      skippedPrNumbers,
      version,
      repositoryUrl,
    );
    console.warn(
      `No new PRs for ${version}; skipping the clean-room proofread and requesting a manual edit.`,
    );
    proofreading = { status: 'no-new-prs', presentInVersions };
  } else if (newEntriesSection === undefined) {
    proofreading = { status: 'unchanged' };
  } else {
    // A generator duplicate is repairable by the clean-room step, but a missing
    // PR reference is never safe to send to it or commit.
    validateGeneratedReleaseSection(readChangelog(), version, true);

    proofreading = runCleanRoomProofread({ repositoryUrl, version });
    // The fallback must still meet the final one-reference-per-PR contract.
    // With a preserved section, only the new entries are checked: the
    // reviewed ones are the reviewer's to word and organize.
    validateGeneratedReleaseSection(readChangelog(), version);
    const restoredSection = restoreGeneratedCategories({
      generatedSection: newEntriesSection,
      cleanedSection: readCurrentReleaseSection(),
      version,
    });
    writeCurrentReleaseSection(
      preservedSection
        ? mergeNewReleaseEntries({
            existingSection: preservedSection,
            newEntriesSection: restoredSection,
            version,
          })
        : restoredSection,
    );
  }
  runChangelogValidation(proofreading, version);

  const assertSourcesUnchanged = () => {
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
  };

  if (dryRun) {
    // Preflight the same source snapshots used for publication, but leave all
    // commits, remote branches, and pull requests unchanged.
    assertSourcesUnchanged();
    console.log(
      `Dry run passed for ${releaseBranch}; no commit, push, or PR update was performed.`,
    );
    return;
  }
  commitAndPushChangelog({
    version,
    changelogBranch,
    releaseBranch,
    expectedRemoteSha: changelogBranchSha,
    proofreading,
    replacesWholeSection: regenerateWholeSection,
    markUnproofread:
      proofreading.status === 'failed' && !preservedReviewedSection,
    generatedThrough: targetReleaseSha,
    assertSourcesUnchanged,
  });
}

// Run only when executed directly, not when the tests import this module.
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
