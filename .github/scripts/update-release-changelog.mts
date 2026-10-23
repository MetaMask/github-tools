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
import { compareSemver, parseReleaseBranch } from './release-version-utils.mts';
import {
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
  const cli = environment.AUTO_CHANGELOG_CLI;
  if (!cli) {
    throw new Error(
      'AUTO_CHANGELOG_CLI must point to the installed auto-changelog CLI',
    );
  }
  return cli;
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

// Discards any stale local state so the work starts from the remote tip.
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

type ReleaseSectionEntry = {
  lines: string[];
  prNumbers: string[];
};

type ReleaseSectionCategory = {
  heading: string;
  entries: ReleaseSectionEntry[];
};

function parseReleaseSectionCategories(
  section: string,
): ReleaseSectionCategory[] {
  const [, ...lines] = section.split(/\r?\n/u);
  const categories: ReleaseSectionCategory[] = [];
  let category: ReleaseSectionCategory | undefined;
  let entry: ReleaseSectionEntry | undefined;

  for (const line of lines) {
    if (line.startsWith('### ')) {
      category = { heading: line, entries: [] };
      categories.push(category);
      entry = undefined;
    } else if (line.startsWith('- ')) {
      if (!category) {
        throw new Error('Release entries must appear under a category heading');
      }
      entry = { lines: [line], prNumbers: getPrNumbers(line) };
      category.entries.push(entry);
    } else if (line !== '' && entry) {
      entry.lines.push(line);
      entry.prNumbers = getPrNumbers(entry.lines.join('\n'));
    } else if (line !== '') {
      throw new Error(`Unexpected release section content: ${line}`);
    }
  }

  return categories;
}

const PR_REFERENCE_PATTERN = /\(#(\d+)\)|#(\d+)/gu;

// The generator appends the entry's own PR last, so earlier refs are prose.
function keepOnlyOwningReference(lines: string[]): string[] {
  const [firstLine = '', ...otherLines] = lines;
  const lastMatch = [...firstLine.matchAll(PR_REFERENCE_PATTERN)].pop();
  const demote = (text: string, keepOffset?: number): string =>
    text.replace(
      PR_REFERENCE_PATTERN,
      (match, parenthesized?: string, bare?: string, offset?: number) =>
        offset === keepOffset ? match : `PR ${parenthesized ?? bare ?? ''}`,
    );
  return [
    demote(firstLine, lastMatch?.index),
    ...otherLines.map((line) => demote(line)),
  ];
}

export function getNewReleaseEntriesSection({
  existingSection,
  generatedSection,
  version,
}: {
  existingSection: string;
  generatedSection: string;
  version: string;
}): string | undefined {
  const existingPrNumbers = new Set(getPrNumbers(existingSection));
  const categories = parseReleaseSectionCategories(generatedSection)
    .map(({ heading, entries }) => ({
      heading,
      entries: entries.flatMap(({ lines }) => {
        const [owner] = getPrNumbers(lines[0] ?? '').slice(-1);
        if (owner === undefined) {
          throw new Error('Generated release entry lacks a PR reference');
        }
        return existingPrNumbers.has(owner)
          ? []
          : [{ lines: keepOnlyOwningReference(lines) }];
      }),
    }))
    .filter(({ entries }) => entries.length > 0);

  if (categories.length === 0) {
    return undefined;
  }

  return [
    `## [${version}]`,
    ...categories.flatMap(({ heading, entries }) => [
      '',
      heading,
      '',
      ...entries.flatMap(({ lines }) => lines),
    ]),
  ].join('\n');
}

/**
 * Puts each AI-cleaned entry back under the category the generator chose, so
 * proofreading cannot recategorize a PR. Entries that merge PRs from different
 * generated categories, or that the generator left Uncategorized, keep the
 * proofreader's category.
 *
 * @param options - Options.
 * @param options.generatedSection - The new-entries section before proofreading.
 * @param options.cleanedSection - The same section after proofreading.
 * @param options.version - The release version.
 * @returns The cleaned section with generator categories restored.
 */
export function restoreGeneratedCategories({
  generatedSection,
  cleanedSection,
  version,
}: {
  generatedSection: string;
  cleanedSection: string;
  version: string;
}): string {
  const generatedCategoryByPr = new Map<string, string>();
  for (const { heading, entries } of parseReleaseSectionCategories(
    generatedSection,
  )) {
    for (const entry of entries) {
      for (const prNumber of entry.prNumbers) {
        generatedCategoryByPr.set(prNumber, heading);
      }
    }
  }

  const buckets = new Map<string, string[]>();
  const order: string[] = [];
  for (const { heading, entries } of parseReleaseSectionCategories(
    cleanedSection,
  )) {
    for (const entry of entries) {
      const generatedHeadings = new Set(
        entry.prNumbers.map((prNumber) => generatedCategoryByPr.get(prNumber)),
      );
      const [only] = [...generatedHeadings];
      const target =
        generatedHeadings.size === 1 &&
        only !== undefined &&
        only !== '### Uncategorized'
          ? only
          : heading;
      if (!buckets.has(target)) {
        buckets.set(target, []);
        order.push(target);
      }
      buckets.get(target)?.push(...entry.lines);
    }
  }

  return [
    `## [${version}]`,
    ...order
      .sort((left, right) => getCategoryRank(left) - getCategoryRank(right))
      .flatMap((heading) => ['', heading, '', ...(buckets.get(heading) ?? [])]),
  ].join('\n');
}

// Matches auto-changelog's `orderedChangeCategories`, which determines the
// order categories are written in a release section.
const CATEGORY_ORDER = [
  'Uncategorized',
  'Added',
  'Changed',
  'Deprecated',
  'Removed',
  'Fixed',
  'Security',
];

function getCategoryRank(heading: string): number {
  const rank = CATEGORY_ORDER.indexOf(heading.slice('### '.length));
  return rank === -1 ? CATEGORY_ORDER.length : rank;
}

/**
 * Merges newly generated entries into an existing release section. Existing
 * lines are never modified. New entries go at the top of a matching category,
 * as auto-changelog does, and a missing category is inserted in canonical
 * order.
 *
 * @param options - Options.
 * @param options.existingSection - The release section to preserve.
 * @param options.newEntriesSection - A release section holding only new entries.
 * @param options.version - The release version.
 * @returns The merged release section.
 */
export function mergeNewReleaseEntries({
  existingSection,
  newEntriesSection,
  version,
}: {
  existingSection: string;
  newEntriesSection: string;
  version: string;
}): string {
  const heading = `## [${version}]`;
  if (!newEntriesSection.startsWith(heading)) {
    throw new Error(`Expected new entries section to begin with ${heading}`);
  }

  const lineEnding = existingSection.includes('\r\n') ? '\r\n' : '\n';
  const lines = existingSection.trimEnd().split(/\r?\n/u);

  for (const {
    heading: categoryHeading,
    entries,
  } of parseReleaseSectionCategories(newEntriesSection)) {
    const entryLines = entries.flatMap((entry) => entry.lines);
    if (entryLines.length === 0) {
      continue;
    }

    const headingIndex = lines.indexOf(categoryHeading);
    if (headingIndex !== -1) {
      // Skip the blank line(s) after the heading so entries lead the list.
      let insertAt = headingIndex + 1;
      while (insertAt < lines.length && lines[insertAt] === '') {
        insertAt += 1;
      }
      const isEmptyCategory =
        insertAt >= lines.length || lines[insertAt]?.startsWith('### ');
      lines.splice(
        insertAt,
        0,
        ...(insertAt === headingIndex + 1 ? [''] : []),
        ...entryLines,
        ...(isEmptyCategory && insertAt < lines.length ? [''] : []),
      );
      continue;
    }

    const rank = getCategoryRank(categoryHeading);
    const nextCategoryIndex = lines.findIndex(
      (line) => line.startsWith('### ') && getCategoryRank(line) > rank,
    );
    if (nextCategoryIndex === -1) {
      lines.push('', categoryHeading, '', ...entryLines);
    } else {
      lines.splice(
        nextCategoryIndex,
        0,
        categoryHeading,
        '',
        ...entryLines,
        '',
      );
    }
  }

  return lines.join(lineEnding);
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

// Stderr is buffered so the verbose skip diagnostics can be parsed.
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

export function getHistoricalSkippedPrNumbers(diagnostics: string): string[] {
  const prNumbers = [
    ...diagnostics.matchAll(
      /\[auto-changelog\] skipped pr=(\d+) reason=historical-pr/gu,
    ),
  ].flatMap((match) => (match[1] ? [match[1]] : []));
  return [...new Set(prNumbers)];
}

export function findReleaseVersionsContainingPrs(
  changelog: string,
  prNumbers: readonly string[],
  excludedVersion: string,
): string[] {
  const wanted = new Set(prNumbers);
  const versions = new Set<string>();
  let currentVersion: string | undefined;
  for (const line of changelog.split(/\r?\n/u)) {
    const heading = /^## \[(\d+\.\d+\.\d+)\]$/u.exec(line);
    if (heading) {
      currentVersion = heading[1];
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

export function isReleaseSectionEmpty(
  changelogContent: string,
  version: string,
): boolean {
  const { section } = extractReleaseSection(changelogContent, version);
  return (section.match(/^- .+$/gmu) ?? []).length === 0;
}

function generateChangelog({
  repositoryUrl,
  version,
}: {
  repositoryUrl: string;
  version: string;
}): string[] {
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

  return getHistoricalSkippedPrNumbers(
    executeAutoChangelogCapturingDiagnostics(commonArguments),
  );
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
  // The validator rejects a release with no entries, which is the expected
  // state here until a human edits the draft PR.
  if (proofreading.status !== 'no-new-prs') {
    executeAutoChangelog(getChangelogValidationArguments(proofreading.status));
  }

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
  presentInVersions = [],
}: {
  version: string;
  changelogBranch: string;
  previousVersionRef: string;
  proofreadingStatus: ProofreadingStatus;
  proofreadingStage?: string;
  presentInVersions?: readonly string[];
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
  if (proofreadingStatus === 'no-new-prs') {
    title = `${title} (no new PRs, manual edit required)`;
    body = `${body}\n\n${getNoNewPrsWarning(version, presentInVersions)}`;
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
      ...(proofreading.presentInVersions
        ? { presentInVersions: proofreading.presentInVersions }
        : {}),
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
  execute('git', ['fetch', 'origin', 'main']);
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

  const existingTargetReleaseSection = hasReleaseHeading(
    `origin/${releaseBranch}`,
    version,
  )
    ? extractReleaseSection(
        readChangelogAtRef(`origin/${releaseBranch}`),
        version,
      ).section
    : undefined;

  const reviewedCurrentReleaseSection =
    baseline.kind === 'target'
      ? undefined
      : getReviewedCurrentReleaseSection({
          changelogBranch,
          changelogBranchSha,
          releaseBranch,
          version,
        });

  if (reviewedCurrentReleaseSection) {
    console.log(
      `Preserving reviewed ${version} section from open changelog branch origin/${changelogBranch}.`,
    );
  }

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
  const skippedPrNumbers = generateChangelog({ repositoryUrl, version });

  // Lines already on the release branch, or reviewed in the open changelog PR,
  // are never reworded; only newly generated PRs go to the proofreader.
  const preservedSection =
    reviewedCurrentReleaseSection ?? existingTargetReleaseSection;
  const generatedSection = extractReleaseSection(
    readFileSync('CHANGELOG.md', 'utf8'),
    version,
  ).section;
  const newEntriesSection = preservedSection
    ? getNewReleaseEntriesSection({
        existingSection: preservedSection,
        generatedSection,
        version,
      })
    : generatedSection;

  if (preservedSection) {
    writeFileSync(
      'CHANGELOG.md',
      replaceReleaseSection(
        readFileSync('CHANGELOG.md', 'utf8'),
        version,
        newEntriesSection ?? preservedSection,
      ),
    );
  }

  let proofreading: ProofreadingResult;
  if (preservedSection && !newEntriesSection) {
    proofreading = { status: 'unchanged' };
  } else if (!newEntriesSection) {
    // An OTA hotfix may only cherry-pick PRs that an earlier release already
    // lists; the draft PR then asks a human to write the section.
    proofreading = { status: 'no-new-prs' };
  } else if (
    parsedReleaseBranch?.kind === 'ota' &&
    isReleaseSectionEmpty(readFileSync('CHANGELOG.md', 'utf8'), version)
  ) {
    const presentInVersions = findReleaseVersionsContainingPrs(
      readFileSync('CHANGELOG.md', 'utf8'),
      skippedPrNumbers,
      version,
    );
    console.warn(
      `No new PRs for ${version}; skipping the clean-room proofread and requesting a manual edit.`,
    );
    proofreading = { status: 'no-new-prs', presentInVersions };
  } else {
    // A generator duplicate is repairable by the clean-room step, but a missing
    // PR reference is never safe to send to it or commit.
    validateGeneratedReleaseSection(
      readFileSync('CHANGELOG.md', 'utf8'),
      version,
      true,
    );

    proofreading = runCleanRoomProofread({ repositoryUrl, version });
    if (preservedSection) {
      const cleanedNewEntries = extractReleaseSection(
        readFileSync('CHANGELOG.md', 'utf8'),
        version,
      ).section;
      writeFileSync(
        'CHANGELOG.md',
        replaceReleaseSection(
          readFileSync('CHANGELOG.md', 'utf8'),
          version,
          mergeNewReleaseEntries({
            existingSection: preservedSection,
            newEntriesSection: restoreGeneratedCategories({
              generatedSection: newEntriesSection,
              cleanedSection: cleanedNewEntries,
              version,
            }),
            version,
          }),
        ),
      );
    }
    // The fallback must still meet the final one-reference-per-PR contract.
    validateGeneratedReleaseSection(
      readFileSync('CHANGELOG.md', 'utf8'),
      version,
    );
  }
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
