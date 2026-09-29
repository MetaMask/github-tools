import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { retry } from './shared/retry.mts';

const MODEL = 'gpt-5.6-terra';
const DEFAULT_BASE_URL = 'https://litellm.consensys.info';
const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_ATTEMPTS = 2;
const GH_API_MAX_ATTEMPTS = 3;
const GH_API_RETRY_DELAY_MS = 1_000;
const MAX_PR_BODY_LENGTH = 4_000;
const MAX_PR_FILES = 40;
const MAX_ENTRIES_PER_CLEAN_ROOM_REQUEST = 20;
const VALID_CATEGORY_NAMES = [
  'Added',
  'Changed',
  'Deprecated',
  'Removed',
  'Fixed',
  'Security',
];

export function getEvidenceEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const scrubbedEnvironment = { ...environment };
  delete scrubbedEnvironment.AI_ANALYZER_LITELLM_KEY;
  return scrubbedEnvironment;
}

const evidenceEnvironment = getEvidenceEnvironment();
const execFileAsync = promisify(execFile);

type GhApiRequest = (argumentsList: string[]) => Promise<string>;

type ReleaseSection = {
  section: string;
  start: number;
  end: number;
};

type LiteLlmResponse = {
  choices?: { message?: { content?: unknown } }[];
};

export class LiteLlmAuthenticationError extends Error {
  constructor(status: number) {
    super(`LiteLLM rejected the credential with HTTP ${String(status)}`);
    this.name = 'LiteLlmAuthenticationError';
  }
}

export function isLiteLlmAuthenticationError(
  error: unknown,
): error is LiteLlmAuthenticationError {
  return error instanceof LiteLlmAuthenticationError;
}

function getArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function writeReport(reportPath: string, report: Record<string, string>): void {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

function fail(reportPath: string, stage: string, error: string): void {
  writeReport(reportPath, { status: 'failed', stage, error });
  console.error(`Clean-room proofread failed during ${stage}: ${error}`);
  process.exitCode = 1;
}

export function extractReleaseSection(
  content: string,
  version: string,
): ReleaseSection {
  const heading = `## [${version}]`;
  const headingMatches = content.match(
    new RegExp(`^## \\[${version.replaceAll('.', '\\.')}\\]$`, 'gmu'),
  );
  if (headingMatches?.length !== 1) {
    throw new Error(`Expected exactly one release heading for ${version}`);
  }

  const start = content.indexOf(heading);
  const nextHeading = content.indexOf('\n## [', start + heading.length);
  const rawEnd = nextHeading === -1 ? content.length : nextHeading + 1;
  const section = content.slice(start, rawEnd).trimEnd();

  return {
    section,
    start,
    end: start + section.length,
  };
}

export function replaceReleaseSection(
  content: string,
  version: string,
  replacement: string,
): string {
  const { start, end } = extractReleaseSection(content, version);
  return `${content.slice(0, start)}${replacement}${content.slice(end)}`;
}

export function getPrNumbers(section: string): string[] {
  return [...section.matchAll(/#(\d+)/gu)].flatMap((match) => {
    const prNumber = match[1];
    return prNumber ? [prNumber] : [];
  });
}

type CleanRoomChunk = {
  section: string;
  prNumbers: string[];
};

export function splitReleaseSectionIntoChunks(
  section: string,
  version: string,
  maxEntries = MAX_ENTRIES_PER_CLEAN_ROOM_REQUEST,
): CleanRoomChunk[] {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new Error('maxEntries must be a positive integer');
  }

  const lines = section.trimEnd().split(/\r?\n/u);
  const heading = `## [${version}]`;
  if (lines[0] !== heading) {
    throw new Error(`Expected section to start with ${heading}`);
  }

  const entries: string[] = [];
  let currentEntry: string[] = [];
  for (const line of lines.slice(1)) {
    if (line.startsWith('- ')) {
      if (currentEntry.length > 0) {
        entries.push(currentEntry.join('\n').trimEnd());
      }
      currentEntry = [line];
    } else if (line.startsWith('### ')) {
      if (currentEntry.length > 0) {
        entries.push(currentEntry.join('\n').trimEnd());
        currentEntry = [];
      }
    } else if (currentEntry.length > 0) {
      currentEntry.push(line);
    } else if (line.trim() !== '') {
      throw new Error(`Unexpected release-section content: ${line}`);
    }
  }
  if (currentEntry.length > 0) {
    entries.push(currentEntry.join('\n').trimEnd());
  }

  const chunks: CleanRoomChunk[] = [];
  const seenPrNumbers = new Set<string>();
  let chunkEntries: string[] = [];
  let chunkPrNumbers: string[] = [];
  const addChunk = () => {
    if (chunkEntries.length === 0) {
      return;
    }
    chunks.push({
      section: `${heading}\n\n### Uncategorized\n\n${chunkEntries.join('\n\n')}`,
      prNumbers: chunkPrNumbers,
    });
    chunkEntries = [];
    chunkPrNumbers = [];
  };

  for (const entry of entries) {
    const entryPrNumbers = getPrNumbers(entry);
    if (entryPrNumbers.length === 0) {
      throw new Error(
        `Generated changelog entry has no PR reference: ${entry}`,
      );
    }
    const uniqueEntryPrNumbers = [...new Set(entryPrNumbers)];
    const alreadySeen = uniqueEntryPrNumbers.filter((prNumber) =>
      seenPrNumbers.has(prNumber),
    );
    if (alreadySeen.length === uniqueEntryPrNumbers.length) {
      continue;
    }
    if (alreadySeen.length > 0) {
      throw new Error(
        `Generated changelog entry overlaps an earlier PR reference: ${alreadySeen.join(', ')}`,
      );
    }
    if (chunkEntries.length === maxEntries) {
      addChunk();
    }
    chunkEntries.push(entry);
    chunkPrNumbers.push(...uniqueEntryPrNumbers);
    uniqueEntryPrNumbers.forEach((prNumber) => seenPrNumbers.add(prNumber));
  }
  addChunk();

  if (chunks.length === 0) {
    throw new Error(`Generated ## [${version}] section contains no entries`);
  }
  return chunks;
}

function getCategorizedBlocks(
  section: string,
  version: string,
): Map<string, string[]> {
  const lines = section.trimEnd().split(/\r?\n/u);
  const heading = `## [${version}]`;
  if (lines[0] !== heading) {
    throw new Error(`Expected section to start with ${heading}`);
  }

  const blocks = new Map<string, string[]>();
  let category: string | undefined;
  let categoryEntries: string[] = [];
  const addCategory = () => {
    if (!category) {
      return;
    }
    if (categoryEntries.length > 0) {
      blocks.set(category, [
        ...(blocks.get(category) ?? []),
        ...categoryEntries,
      ]);
    }
  };

  for (const line of lines.slice(1)) {
    const categoryMatch = /^### (.+)$/u.exec(line);
    if (categoryMatch) {
      addCategory();
      category = categoryMatch[1];
      categoryEntries = [];
    } else if (line === '') {
      continue;
    } else if (category && line.startsWith('- ')) {
      if (/\)\s*\+?-\s/u.test(line)) {
        throw new Error(`Response contains adjacent list items: ${line}`);
      }
      categoryEntries.push(line);
    } else if (category) {
      throw new Error(`Response contains unexpected Markdown: ${line}`);
    } else if (line.trim() !== '') {
      throw new Error(`Unexpected release-section content: ${line}`);
    }
  }
  addCategory();
  return blocks;
}

export function mergeCleanRoomSections(
  sections: readonly string[],
  version: string,
): string {
  const blocksByCategory = new Map<string, string[]>();
  for (const section of sections) {
    const categorizedBlocks = getCategorizedBlocks(section, version);
    for (const [category, blocks] of categorizedBlocks) {
      blocksByCategory.set(category, [
        ...(blocksByCategory.get(category) ?? []),
        ...blocks,
      ]);
    }
  }

  const categories = VALID_CATEGORY_NAMES.flatMap((category) => {
    const blocks = blocksByCategory.get(category) ?? [];
    return blocks.length > 0 ? [`### ${category}\n\n${blocks.join('\n')}`] : [];
  });
  return `## [${version}]\n\n${categories.join('\n\n')}`;
}

export function validateReplacement(
  section: string,
  version: string,
  expectedPrNumbers: readonly string[],
): void {
  if (!section.startsWith(`## [${version}]\n`)) {
    throw new Error(`Response must start with ## [${version}]`);
  }
  if (/^## \[/mu.test(section.slice(`## [${version}]`.length))) {
    throw new Error('Response must contain only one release section');
  }
  if (/^### Uncategorized$/mu.test(section)) {
    throw new Error('Response must not contain Uncategorized');
  }

  const categoryPattern =
    /^### (Added|Changed|Deprecated|Removed|Fixed|Security)$/gmu;
  const categories = [...section.matchAll(categoryPattern)];
  if (categories.length === 0) {
    throw new Error('Response must contain at least one valid category');
  }

  const categoryNames = new Set<string>();
  for (const category of categories) {
    const categoryName = category[1] ?? 'unknown';
    if (categoryNames.has(categoryName)) {
      throw new Error(`Response contains duplicate ${categoryName} categories`);
    }
    categoryNames.add(categoryName);

    const categoryStart = (category.index ?? 0) + category[0].length;
    const nextCategory = section.indexOf('\n### ', categoryStart);
    const categoryBody = section.slice(
      categoryStart,
      nextCategory === -1 ? undefined : nextCategory,
    );
    const categoryEntries = categoryBody
      .split(/\r?\n/u)
      .filter((line) => line !== '');
    if (categoryEntries.length === 0) {
      throw new Error(`Category ${categoryName} must not be empty`);
    }
    for (const entry of categoryEntries) {
      if (!entry.startsWith('- ')) {
        throw new Error(`Response contains unexpected Markdown: ${entry}`);
      }
      if (/\)\s*\+?-\s/u.test(entry)) {
        throw new Error(`Response contains adjacent list items: ${entry}`);
      }
    }
  }

  const releaseBody = section.slice(`## [${version}]`.length);
  for (const line of releaseBody.split(/\r?\n/u)) {
    if (
      line === '' ||
      categoryPattern.test(line) ||
      line.startsWith('- ') ||
      /^\s+/u.test(line)
    ) {
      categoryPattern.lastIndex = 0;
      continue;
    }
    throw new Error(`Response contains unexpected Markdown: ${line}`);
  }
  if (/\[[^\]]+\]\([^)]/u.test(releaseBody)) {
    throw new Error(
      'Response must not contain Markdown links in entry descriptions',
    );
  }

  const actualPrNumbers = getPrNumbers(section);
  const expected = new Set(expectedPrNumbers);
  const actual = new Set(actualPrNumbers);
  if (
    expected.size !== actual.size ||
    [...expected].some((prNumber) => !actual.has(prNumber))
  ) {
    throw new Error(
      'Response PR references do not match the generated section',
    );
  }
  if (actualPrNumbers.length !== actual.size) {
    throw new Error('Response contains duplicate PR references');
  }
}

type PullRequestMetadata = {
  title?: unknown;
  body?: unknown;
};

export function assertPrEvidenceAvailable(
  unavailablePrNumbers: readonly string[],
): void {
  if (unavailablePrNumbers.length > 0) {
    throw new Error(
      `PR evidence unavailable for ${unavailablePrNumbers
        .map((prNumber) => `#${prNumber}`)
        .join(', ')}`,
    );
  }
}

function getErrorDetails(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const extendedError = error as Error & { stderr?: unknown; stdout?: unknown };
  return [error.message, extendedError.stderr, extendedError.stdout]
    .filter((value): value is string => typeof value === 'string')
    .join('\n');
}

export function isRetryableGhApiFailure(error: unknown): boolean {
  return /\b(?:429|500|502|503|504)\b|rate limit|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|ETIMEDOUT|socket hang up/iu.test(
    getErrorDetails(error),
  );
}

async function executeGhApi(argumentsList: string[]): Promise<string> {
  const { stdout } = await execFileAsync('gh', ['api', ...argumentsList], {
    encoding: 'utf8',
    env: evidenceEnvironment,
  });
  return stdout;
}

export async function requestGhApiWithRetry(
  argumentsList: string[],
  request: GhApiRequest = executeGhApi,
  sleep?: (milliseconds: number) => Promise<void>,
): Promise<string> {
  return await retry(async () => request(argumentsList), {
    delayMilliseconds: GH_API_RETRY_DELAY_MS,
    maxAttempts: GH_API_MAX_ATTEMPTS,
    onRetry: ({ attempt, delayMilliseconds }) => {
      console.warn(
        `Retrying GitHub evidence request after transient failure (attempt ${attempt + 1}/${GH_API_MAX_ATTEMPTS} in ${delayMilliseconds}ms).`,
      );
    },
    shouldRetry: isRetryableGhApiFailure,
    ...(sleep ? { sleep } : {}),
  });
}

async function getPrEvidence(
  repository: string,
  prNumbers: readonly string[],
): Promise<{ evidence: string[]; unavailablePrNumbers: string[] }> {
  const match = /github\.com[/:]([^/]+)\/([^/]+)$/u.exec(
    repository.replace(/\.git$/u, ''),
  );
  if (!match) {
    throw new Error(`Cannot parse GitHub repository URL: ${repository}`);
  }

  const owner = match[1];
  const repo = match[2];
  if (!owner || !repo) {
    throw new Error(`Cannot parse GitHub repository URL: ${repository}`);
  }
  const evidence: string[] = [];
  const unavailablePrNumbers: string[] = [];
  const uniquePrNumbers = [...new Set(prNumbers)];
  console.log(
    `Collecting GitHub evidence for ${uniquePrNumbers.length} changelog PRs.`,
  );
  for (const [index, prNumber] of uniquePrNumbers.entries()) {
    try {
      console.log(
        `Collecting evidence for PR ${index + 1}/${uniquePrNumbers.length}.`,
      );
      const pullRequest = JSON.parse(
        await requestGhApiWithRetry([
          `repos/${owner}/${repo}/pulls/${prNumber}`,
        ]),
      ) as PullRequestMetadata;
      const title =
        typeof pullRequest.title === 'string' ? pullRequest.title : undefined;
      if (!title) {
        throw new Error('PR title is unavailable');
      }
      const body =
        typeof pullRequest.body === 'string'
          ? pullRequest.body.slice(0, MAX_PR_BODY_LENGTH)
          : '<body unavailable>';
      const files = (
        await requestGhApiWithRetry([
          `repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=${MAX_PR_FILES}`,
          '--jq',
          '.[].filename',
        ])
      )
        .split(/\r?\n/u)
        .filter(Boolean)
        .slice(0, MAX_PR_FILES);
      evidence.push(
        `#${prNumber}: ${title}\nBody:\n${body}\nChanged files:\n${files.join('\n') || '<files unavailable>'}`,
      );
    } catch {
      unavailablePrNumbers.push(prNumber);
    }
  }
  return { evidence, unavailablePrNumbers };
}

async function requestCleanRoomRewrite({
  prompt,
  section,
  prEvidence,
  apiKey,
}: {
  prompt: string;
  section: string;
  prEvidence: readonly string[];
  apiKey: string;
}): Promise<string> {
  const baseUrl = (process.env.LITELLM_BASE_URL ?? DEFAULT_BASE_URL).replace(
    /\/$/u,
    '',
  );
  const maxCompletionTokensField = 'max_completion_tokens';
  const requestBody: Record<string, unknown> = {
    model: MODEL,
    temperature: 0,
    [maxCompletionTokensField]: 16_000,
    messages: [
      {
        role: 'system',
        content: 'Return only the requested Markdown release section.',
      },
      {
        role: 'user',
        content: `${prompt}\n\n## Input\n\n<release_section>\n${section}\n</release_section>\n\n<pr_evidence>\n${prEvidence.join('\n\n')}\n</pr_evidence>`,
      },
    ],
  };

  let lastError: string | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Number(process.env.CHANGELOG_AI_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
    );
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new LiteLlmAuthenticationError(response.status);
        }
        throw new Error(`LiteLLM returned HTTP ${String(response.status)}`);
      }

      const payload = (await response.json()) as LiteLlmResponse;
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.trim() === '') {
        throw new Error('LiteLLM returned no message content');
      }
      return content.trim();
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (isLiteLlmAuthenticationError(error)) {
        throw error;
      }
      if (attempt < MAX_ATTEMPTS) {
        console.warn(
          `Retrying clean-room model request (attempt ${attempt + 1}/${MAX_ATTEMPTS} in 1000ms).`,
        );
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(lastError ?? 'LiteLLM request failed');
}

async function main(): Promise<void> {
  const changelogPath = getArgument('--changelog');
  const version = getArgument('--version');
  const repository = getArgument('--repository');
  const promptPath = getArgument('--prompt');
  const reportPath =
    getArgument('--report') ?? '.tmp/release-changelog-ai/report.json';

  if (!changelogPath || !version || !repository || !promptPath) {
    fail(
      reportPath,
      'arguments',
      'Required arguments: --changelog, --version, --repository, --prompt',
    );
    return;
  }

  const apiKey = process.env.AI_ANALYZER_LITELLM_KEY;
  if (!apiKey) {
    fail(reportPath, 'authentication', 'AI_ANALYZER_LITELLM_KEY is not set');
    return;
  }

  try {
    const absoluteChangelogPath = resolve(changelogPath);
    const changelogContent = readFileSync(absoluteChangelogPath, 'utf8');
    const { section } = extractReleaseSection(changelogContent, version);
    const prompt = readFileSync(promptPath, 'utf8');
    const sourcePrNumbers = getPrNumbers(section);
    console.log(`Clean-room proofreading started with ${MODEL}.`);
    const prEvidence = await getPrEvidence(repository, sourcePrNumbers);
    assertPrEvidenceAvailable(prEvidence.unavailablePrNumbers);
    console.log(
      `Collected evidence for ${prEvidence.evidence.length} changelog PRs.`,
    );
    const evidenceByPrNumber = new Map(
      prEvidence.evidence.flatMap((evidence) => {
        const match = /^#(\d+):/u.exec(evidence);
        return match?.[1] ? [[match[1], evidence]] : [];
      }),
    );
    const chunks = splitReleaseSectionIntoChunks(section, version);
    const cleanRoomSections: string[] = [];
    for (const [index, chunk] of chunks.entries()) {
      const chunkEvidence = chunk.prNumbers.map((prNumber) => {
        const evidence = evidenceByPrNumber.get(prNumber);
        if (!evidence) {
          throw new Error(`PR evidence is unavailable for #${prNumber}`);
        }
        return evidence;
      });
      console.log(
        `Requesting clean-room rewrite for chunk ${index + 1}/${chunks.length} (${chunk.prNumbers.length} PRs).`,
      );
      const cleanRoomSection = await requestCleanRoomRewrite({
        prompt,
        section: chunk.section,
        prEvidence: chunkEvidence,
        apiKey,
      });
      validateReplacement(cleanRoomSection, version, chunk.prNumbers);
      cleanRoomSections.push(cleanRoomSection);
      console.log(`Validated clean-room chunk ${index + 1}/${chunks.length}.`);
    }
    const replacement = mergeCleanRoomSections(cleanRoomSections, version);
    validateReplacement(replacement, version, sourcePrNumbers);
    console.log('Validated merged clean-room release section.');

    writeFileSync(
      absoluteChangelogPath,
      replaceReleaseSection(changelogContent, version, replacement),
    );
    writeReport(reportPath, { status: 'succeeded', model: MODEL });
    console.log(`Clean-room proofreading completed with ${MODEL}.`);
  } catch (error) {
    const stage = isLiteLlmAuthenticationError(error)
      ? 'authentication'
      : 'cleaning';
    fail(
      reportPath,
      stage,
      error instanceof Error ? error.message : String(error),
    );
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
