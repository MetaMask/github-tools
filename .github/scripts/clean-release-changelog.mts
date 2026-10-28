import { execFile } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  CHANGE_CATEGORIES,
  extractReleaseSection,
  getEntryPrNumbers,
  getPrNumbers,
  releaseHeading,
  replaceReleaseSection,
  splitLines,
} from './release-section.mts';
import { getEnvironmentWithoutAiKey } from './shared/environment.mts';
import { writeReport } from './shared/report.mts';
import { retry } from './shared/retry.mts';

const MODEL = 'gpt-5.6-terra';
const DEFAULT_BASE_URL = 'https://litellm.consensys.info';
const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_ATTEMPTS = 2;
const MAX_VALIDATION_ATTEMPTS = 3;
const GH_API_MAX_ATTEMPTS = 3;
const GH_API_RETRY_DELAY_MS = 1_000;
const MAX_PR_BODY_LENGTH = 4_000;
const MAX_ENTRIES_PER_CLEAN_ROOM_REQUEST = 20;
// `setTimeout` treats a larger delay as 1 ms.
const MAX_TIMEOUT_MS = 2_147_483_647;

const evidenceEnvironment = getEnvironmentWithoutAiKey();
const execFileAsync = promisify(execFile);
const EVIDENCE_MAX_BUFFER = 10 * 1024 * 1024;

type GhApiRequest = (argumentsList: string[]) => Promise<string>;

type LiteLlmResponse = {
  choices?: { message?: { content?: unknown } }[];
};

/** Thrown when LiteLLM rejects the API key. Retrying cannot help. */
export class LiteLlmAuthenticationError extends Error {
  /**
   * Creates the error for a rejected credential.
   *
   * @param status - The HTTP status LiteLLM returned.
   */
  constructor(status: number) {
    super(`LiteLLM rejected the credential with HTTP ${String(status)}`);
    this.name = 'LiteLlmAuthenticationError';
  }
}

/**
 * Checks whether an error is a rejected-credential error.
 *
 * @param error - The error to check.
 * @returns True for `LiteLlmAuthenticationError`.
 */
export function isLiteLlmAuthenticationError(
  error: unknown,
): error is LiteLlmAuthenticationError {
  return error instanceof LiteLlmAuthenticationError;
}

/**
 * Reads the per-attempt model timeout from the environment.
 *
 * @returns The timeout in milliseconds.
 * @throws If `CHANGELOG_AI_TIMEOUT_MS` is set but is not a positive integer.
 */
function getTimeoutMs(): number {
  const configured = process.env.CHANGELOG_AI_TIMEOUT_MS;
  if (configured === undefined) {
    return DEFAULT_TIMEOUT_MS;
  }
  const timeoutMs = Number(configured);
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new Error(
      `CHANGELOG_AI_TIMEOUT_MS must be a positive integer up to ${MAX_TIMEOUT_MS}, got "${configured}"`,
    );
  }
  return timeoutMs;
}

/**
 * Reads the value following a `--name` command-line flag.
 *
 * @param name - The flag, including dashes.
 * @returns The value, or undefined when the flag is absent.
 */
function getArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

/**
 * Records a failure in the report and fails the process.
 *
 * @param reportPath - Where to write the report.
 * @param stage - The stage that failed.
 * @param error - The error message.
 */
function fail(reportPath: string, stage: string, error: string): void {
  writeReport(reportPath, { status: 'failed', stage, error });
  console.error(`Clean-room proofread failed during ${stage}: ${error}`);
  process.exitCode = 1;
}

type CleanRoomChunk = {
  section: string;
  prNumbers: string[];
};

type CategorizedEntry = {
  category: string;
  text: string;
};

/**
 * Splits a generated release section into chunks small enough for one model
 * request each. Every chunk keeps its entries under the generator's
 * categories, which the model may correct.
 *
 * @param section - The generated release section.
 * @param version - The release version.
 * @param maxEntries - The most entries per chunk.
 * @returns The chunks and the PR numbers each one covers.
 * @throws If an entry has no PR reference, partly overlaps an earlier entry's
 * PRs, differs from an earlier entry for the same PRs, or the section has no
 * entries. An identical repeat is skipped with a warning.
 */
export function splitReleaseSectionIntoChunks(
  section: string,
  version: string,
  maxEntries = MAX_ENTRIES_PER_CLEAN_ROOM_REQUEST,
): CleanRoomChunk[] {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new Error('maxEntries must be a positive integer');
  }

  const lines = splitLines(section.trimEnd());
  const heading = releaseHeading(version);
  if (lines[0] !== heading) {
    throw new Error(`Expected section to start with ${heading}`);
  }

  const entries: CategorizedEntry[] = [];
  let category: string | undefined;
  let currentEntry: string[] = [];
  const endEntry = () => {
    if (category && currentEntry.length > 0) {
      entries.push({ category, text: currentEntry.join('\n').trimEnd() });
    }
    currentEntry = [];
  };
  for (const line of lines.slice(1)) {
    if (line.startsWith('- ') && category) {
      endEntry();
      currentEntry = [line];
    } else if (line.startsWith('### ')) {
      endEntry();
      category = line.slice('### '.length).trim();
    } else if (currentEntry.length > 0) {
      currentEntry.push(line);
    } else if (line.trim() !== '') {
      throw new Error(`Unexpected release-section content: ${line}`);
    }
  }
  endEntry();

  const chunks: CleanRoomChunk[] = [];
  const entryByPrNumber = new Map<string, string>();
  let chunkEntries = new Map<string, string[]>();
  let chunkEntryCount = 0;
  let chunkPrNumbers: string[] = [];
  const addChunk = () => {
    if (chunkEntryCount === 0) {
      return;
    }
    const categories = [...chunkEntries].map(
      ([name, texts]) => `### ${name}\n\n${texts.join('\n\n')}`,
    );
    chunks.push({
      section: `${heading}\n\n${categories.join('\n\n')}`,
      prNumbers: chunkPrNumbers,
    });
    chunkEntries = new Map();
    chunkEntryCount = 0;
    chunkPrNumbers = [];
  };

  for (const { category: entryCategory, text: entry } of entries) {
    const entryPrNumbers = getEntryPrNumbers(entry);
    if (entryPrNumbers.length === 0) {
      throw new Error(
        `Generated changelog entry has no PR reference: ${entry}`,
      );
    }
    const uniqueEntryPrNumbers = [...new Set(entryPrNumbers)];
    const alreadySeen = uniqueEntryPrNumbers.filter((prNumber) =>
      entryByPrNumber.has(prNumber),
    );
    if (alreadySeen.length === uniqueEntryPrNumbers.length) {
      const earlierEntry = entryByPrNumber.get(alreadySeen[0] ?? '');
      if (earlierEntry !== entry) {
        throw new Error(
          `Generated section has different entries for PR ${alreadySeen.join(', ')}: ${earlierEntry ?? ''} / ${entry}`,
        );
      }
      console.warn(
        `Skipping duplicate entry for PR ${alreadySeen.join(', ')}: ${entry}`,
      );
      continue;
    }
    if (alreadySeen.length > 0) {
      throw new Error(
        `Generated changelog entry overlaps an earlier PR reference: ${alreadySeen.join(', ')}`,
      );
    }
    if (chunkEntryCount === maxEntries) {
      addChunk();
    }
    chunkEntries.set(entryCategory, [
      ...(chunkEntries.get(entryCategory) ?? []),
      entry,
    ]);
    chunkEntryCount += 1;
    chunkPrNumbers.push(...uniqueEntryPrNumbers);
    uniqueEntryPrNumbers.forEach((prNumber) =>
      entryByPrNumber.set(prNumber, entry),
    );
  }
  addChunk();

  if (chunks.length === 0) {
    throw new Error(`Generated ## [${version}] section contains no entries`);
  }
  return chunks;
}

const CATEGORY_HEADING = new RegExp(
  `^### (${CHANGE_CATEGORIES.join('|')})$`,
  'u',
);

// Text, then the PR reference at the end with no trailing period, which is
// the form auto-changelog writes and `auto-changelog validate` accepts.
const CANONICAL_ENTRY = /^- .*\S \(#\d+(?:, #\d+)*\)$/u;

// Two entries the model ran together on one line, as in `(#101) - Next`.
const ADJACENT_LIST_ITEMS = /\(#\d+(?:, #\d+)*\)\.?\s*\+?-\s/u;

/**
 * Rejects a line that holds more than one list item.
 *
 * @param line - A list line from a model response.
 * @throws If the line runs two entries together.
 */
function assertNotAdjacentListItems(line: string): void {
  if (ADJACENT_LIST_ITEMS.test(line)) {
    throw new Error(`Response contains adjacent list items: ${line}`);
  }
}

/**
 * Groups a model response's entries by category, rejecting stray Markdown.
 * It is deliberately strict because the input is untrusted model output.
 *
 * @param section - One chunk's cleaned section.
 * @param version - The release version.
 * @returns The entry lines for each category.
 * @throws If the section has content other than categories and entries.
 */
function getCategorizedBlocks(
  section: string,
  version: string,
): Map<string, string[]> {
  const lines = splitLines(section.trimEnd());
  const heading = releaseHeading(version);
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
      assertNotAdjacentListItems(line);
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

/**
 * Combines the cleaned chunks into one release section, with the categories in
 * auto-changelog's order.
 *
 * @param sections - The cleaned chunk sections.
 * @param version - The release version.
 * @returns The merged release section.
 */
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

  const categories = CHANGE_CATEGORIES.flatMap((category) => {
    const blocks = blocksByCategory.get(category) ?? [];
    return blocks.length > 0 ? [`### ${category}\n\n${blocks.join('\n')}`] : [];
  });
  return `${releaseHeading(version)}\n\n${categories.join('\n\n')}`;
}

/**
 * Checks that a model's output is a well-formed release section holding
 * exactly the expected PRs, so a bad response is never written to the file.
 *
 * @param section - The section to validate.
 * @param version - The release version.
 * @param expectedPrNumbers - The PRs the section must reference, once each.
 * @throws If the section is malformed or its PR references differ.
 */
export function validateReplacement(
  section: string,
  version: string,
  expectedPrNumbers: readonly string[],
): void {
  const heading = releaseHeading(version);
  if (!section.startsWith(`${heading}\n`)) {
    throw new Error(`Response must start with ${heading}`);
  }
  if (/^## \[/mu.test(section.slice(heading.length))) {
    throw new Error('Response must contain only one release section');
  }
  if (/^### Uncategorized$/mu.test(section)) {
    throw new Error('Response must not contain Uncategorized');
  }

  const categoryNames = new Set<string>();
  let category: string | undefined;
  let categoryEntryCount = 0;
  const endCategory = () => {
    if (category && categoryEntryCount === 0) {
      throw new Error(`Category ${category} must not be empty`);
    }
  };
  const releaseBody = section.slice(heading.length);
  for (const line of splitLines(releaseBody)) {
    const categoryName = CATEGORY_HEADING.exec(line)?.[1];
    if (line === '') {
      continue;
    } else if (categoryName) {
      endCategory();
      if (categoryNames.has(categoryName)) {
        throw new Error(
          `Response contains duplicate ${categoryName} categories`,
        );
      }
      categoryNames.add(categoryName);
      category = categoryName;
      categoryEntryCount = 0;
    } else if (category && line.startsWith('- ')) {
      assertNotAdjacentListItems(line);
      if (!CANONICAL_ENTRY.test(line)) {
        throw new Error(
          `Response entry must be text followed by its PR reference: ${line}`,
        );
      }
      categoryEntryCount += 1;
    } else {
      throw new Error(`Response contains unexpected Markdown: ${line}`);
    }
  }
  endCategory();
  if (categoryNames.size === 0) {
    throw new Error('Response must contain at least one valid category');
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

type UnavailablePrEvidence = {
  prNumber: string;
  error: string;
};

/**
 * Fails when evidence for any PR could not be collected, because the model
 * must not rewrite an entry it has no evidence for.
 *
 * @param unavailablePrEvidence - The PRs whose evidence is missing.
 * @throws If the list is not empty.
 */
export function assertPrEvidenceAvailable(
  unavailablePrEvidence: readonly UnavailablePrEvidence[],
): void {
  if (unavailablePrEvidence.length > 0) {
    throw new Error(
      `PR evidence unavailable: ${unavailablePrEvidence
        .map(({ prNumber, error }) => `#${prNumber} (${error})`)
        .join(', ')}`,
    );
  }
}

/**
 * Describes an error, including a child process's stderr and stdout.
 *
 * @param error - The error.
 * @returns The details as text.
 */
function getErrorDetails(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const extendedError = error as Error & { stderr?: unknown; stdout?: unknown };
  return [error.message, extendedError.stderr, extendedError.stdout]
    .filter((value): value is string => typeof value === 'string')
    .join('\n');
}

/**
 * Checks whether a `gh api` failure looks transient.
 *
 * @param error - The failure.
 * @returns True for rate limits, 5xx responses, and network errors.
 */
export function isRetryableGhApiFailure(error: unknown): boolean {
  return /\bHTTP (?:429|500|502|503|504)\b|rate limit|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|ETIMEDOUT|socket hang up/iu.test(
    getErrorDetails(error),
  );
}

/**
 * Runs `gh api` without the LiteLLM credential in its environment.
 *
 * @param argumentsList - The arguments after `gh api`.
 * @returns The response body.
 */
async function executeGhApi(argumentsList: string[]): Promise<string> {
  const { stdout } = await execFileAsync('gh', ['api', ...argumentsList], {
    encoding: 'utf8',
    env: evidenceEnvironment,
    maxBuffer: EVIDENCE_MAX_BUFFER,
  });
  return stdout;
}

/**
 * Runs a `gh api` request, retrying transient failures.
 *
 * @param argumentsList - The arguments after `gh api`.
 * @param request - Runs the request; replaced in tests.
 * @param sleep - Waits between attempts; replaced in tests.
 * @returns The response body.
 */
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
    sleep,
  });
}

/**
 * Builds the `git log` arguments that find the squash commits for PRs.
 *
 * @param prNumbers - The PR numbers to find.
 * @returns The arguments, or undefined when there are no PRs.
 */
export function getLocalEvidenceLogArguments(
  prNumbers: readonly string[],
): string[] | undefined {
  const uniquePrNumbers = [...new Set(prNumbers)];
  if (uniquePrNumbers.length === 0) {
    return undefined;
  }

  return [
    'log',
    'HEAD',
    '--extended-regexp',
    `--grep=\\(#(${uniquePrNumbers.join('|')})\\)`,
    '--format=%H%x1f%s%x1f%b%x1e',
  ];
}

/**
 * Checks whether a commit is reachable from `origin/main`.
 *
 * @param commitHash - The commit.
 * @returns True when it is on main.
 */
async function isCommitOnMain(commitHash: string): Promise<boolean> {
  try {
    await execFileAsync(
      'git',
      ['merge-base', '--is-ancestor', commitHash, 'origin/main'],
      {
        env: evidenceEnvironment,
      },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Collects evidence for PRs from their squash commits already on `main`,
 * skipping cherry-picks, so those PRs need no GitHub request.
 *
 * @param prNumbers - The PR numbers to look up.
 * @returns The evidence text by PR number, for the PRs that were found.
 */
export async function getLocalPrEvidence(
  prNumbers: readonly string[],
): Promise<Map<string, string>> {
  const argumentsList = getLocalEvidenceLogArguments(prNumbers);
  if (!argumentsList) {
    return new Map();
  }

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('git', argumentsList, {
      encoding: 'utf8',
      env: evidenceEnvironment,
      maxBuffer: EVIDENCE_MAX_BUFFER,
    }));
  } catch (error) {
    console.warn(
      `Local PR evidence is unavailable; using GitHub instead: ${getErrorDetails(error)}`,
    );
    return new Map();
  }
  const wantedPrNumbers = new Set(prNumbers);
  const evidence = new Map<string, string>();

  for (const record of stdout.split('\x1e')) {
    const [hash, subject, body] = record.trim().split('\x1f');
    if (
      !hash ||
      !subject ||
      /\bcherry-pick(?:ing)?\b/iu.test(`${subject}\n${body ?? ''}`)
    ) {
      continue;
    }
    // A squash commit's own PR is the last one; earlier ones are quoted, as in
    // a revert's subject.
    const number = [...subject.matchAll(/\(#(\d+)\)/gu)].at(-1)?.[1];
    if (!number || !wantedPrNumbers.has(number) || evidence.has(number)) {
      continue;
    }
    // On a release branch the newest match is often a cherry-pick that is not
    // on main, so the mainline commit has to be found behind it.
    if (await isCommitOnMain(hash)) {
      evidence.set(
        number,
        `#${number}: ${subject}\nLocal squash commit body:\n${(body ?? '').slice(0, MAX_PR_BODY_LENGTH) || '<body unavailable>'}`,
      );
    }
  }
  return evidence;
}

/**
 * Collects each PR's title and body as evidence for the model, preferring
 * local evidence and fetching the rest from GitHub.
 *
 * @param repository - The GitHub repository URL.
 * @param prNumbers - The PR numbers to collect.
 * @param request - Runs a `gh api` request; replaced in tests.
 * @param localEvidence - Evidence already found locally, by PR number.
 * @returns The evidence, and the PRs whose evidence could not be fetched.
 * @throws If the repository URL cannot be parsed.
 */
export async function getPrEvidence(
  repository: string,
  prNumbers: readonly string[],
  request: GhApiRequest = executeGhApi,
  localEvidence: ReadonlyMap<string, string> = new Map(),
): Promise<{
  evidence: string[];
  unavailablePrEvidence: UnavailablePrEvidence[];
}> {
  const match = /github\.com[/:]([^/]+)\/([^/]+)$/u.exec(
    repository.replace(/\.git$/u, ''),
  );
  const [, owner, repo] = match ?? [];
  if (!owner || !repo) {
    throw new Error(`Cannot parse GitHub repository URL: ${repository}`);
  }
  const evidence: string[] = [];
  const unavailablePrEvidence: UnavailablePrEvidence[] = [];
  const uniquePrNumbers = [...new Set(prNumbers)];
  console.log(
    `Collecting evidence for ${uniquePrNumbers.length} changelog PRs.`,
  );
  for (const [index, prNumber] of uniquePrNumbers.entries()) {
    const localPrEvidence = localEvidence.get(prNumber);
    if (localPrEvidence) {
      evidence.push(localPrEvidence);
      continue;
    }
    try {
      console.log(
        `Collecting evidence for PR ${index + 1}/${uniquePrNumbers.length}.`,
      );
      const pullRequest = JSON.parse(
        await requestGhApiWithRetry(
          [`repos/${owner}/${repo}/pulls/${prNumber}`],
          request,
        ),
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
      evidence.push(`#${prNumber}: ${title}\nBody:\n${body}`);
    } catch (error) {
      unavailablePrEvidence.push({
        prNumber,
        error: getErrorDetails(error),
      });
    }
  }
  return { evidence, unavailablePrEvidence };
}

/**
 * Asks the model to rewrite one chunk of entries from the PR evidence.
 *
 * @param options - Options.
 * @param options.prompt - The clean-room instructions.
 * @param options.section - The chunk to rewrite.
 * @param options.prEvidence - The evidence for the chunk's PRs.
 * @param options.apiKey - The LiteLLM API key.
 * @param options.fetchImpl - The fetch to use; replaced in tests.
 * @param options.sleep - Waits between attempts; replaced in tests.
 * @param options.timeoutMs - How long to wait for each attempt.
 * @returns The model's Markdown.
 * @throws `LiteLlmAuthenticationError` when the key is rejected, otherwise
 * the last failure once attempts run out.
 */
export async function requestCleanRoomRewrite({
  prompt,
  section,
  prEvidence,
  apiKey,
  fetchImpl = fetch,
  sleep,
  timeoutMs = getTimeoutMs(),
}: {
  prompt: string;
  section: string;
  prEvidence: readonly string[];
  apiKey: string;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
}): Promise<string> {
  const baseUrl = (process.env.LITELLM_BASE_URL ?? DEFAULT_BASE_URL).replace(
    /\/$/u,
    '',
  );
  // Built through a variable because lint rejects the API's snake_case key.
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

  return retry(
    async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(`${baseUrl}/chat/completions`, {
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
      } finally {
        clearTimeout(timeout);
      }
    },
    {
      maxAttempts: MAX_ATTEMPTS,
      sleep,
      // A rejected credential never succeeds on retry.
      shouldRetry: (error) => !isLiteLlmAuthenticationError(error),
      onRetry: ({ attempt, delayMilliseconds }) => {
        console.warn(
          `Retrying clean-room model request (attempt ${attempt + 1}/${MAX_ATTEMPTS} in ${delayMilliseconds}ms).`,
        );
      },
    },
  );
}

/** Thrown when a model response fails validation. A new response may pass. */
class RewriteValidationError extends Error {
  /**
   * Wraps the validation failure, keeping its message.
   *
   * @param cause - The validation failure.
   */
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'RewriteValidationError';
  }
}

/**
 * Asks the model to rewrite one chunk and validates the response. The model is
 * not deterministic even at temperature 0, so a response that fails validation
 * is requested again.
 *
 * @param options - The request, as for `requestCleanRoomRewrite`.
 * @param version - The release version.
 * @param prNumbers - The PRs the response must reference, once each.
 * @param maxAttempts - How many responses to try.
 * @returns The first response that passes validation.
 * @throws The last validation failure, or any request failure.
 */
export async function requestValidatedRewrite(
  options: Parameters<typeof requestCleanRoomRewrite>[0],
  version: string,
  prNumbers: readonly string[],
  maxAttempts = MAX_VALIDATION_ATTEMPTS,
): Promise<string> {
  return retry(
    async () => {
      const section = await requestCleanRoomRewrite(options);
      try {
        validateReplacement(section, version, prNumbers);
      } catch (error) {
        throw new RewriteValidationError(error);
      }
      return section;
    },
    {
      delayMilliseconds: 0,
      maxAttempts,
      shouldRetry: (error) => error instanceof RewriteValidationError,
      onRetry: ({ attempt, error }) => {
        console.warn(
          `Response ${attempt}/${maxAttempts} failed validation, requesting another: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    },
  );
}

/**
 * Proofreads a release section in place and writes a report. Any failure is
 * recorded in the report and leaves the changelog untouched.
 */
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
    const chunks = splitReleaseSectionIntoChunks(section, version);
    const sourcePrNumbers = chunks.flatMap(({ prNumbers }) => prNumbers);
    console.log(`Clean-room proofreading started with ${MODEL}.`);
    const localPrEvidence = await getLocalPrEvidence(sourcePrNumbers);
    console.log(
      `Using local mainline squash evidence for ${localPrEvidence.size} changelog PRs.`,
    );
    const prEvidence = await getPrEvidence(
      repository,
      sourcePrNumbers,
      executeGhApi,
      localPrEvidence,
    );
    assertPrEvidenceAvailable(prEvidence.unavailablePrEvidence);
    console.log(
      `Collected evidence for ${prEvidence.evidence.length} changelog PRs.`,
    );
    // Each evidence string starts with `#123:`, which keys it by PR.
    const evidenceByPrNumber = new Map(
      prEvidence.evidence.flatMap((evidence) => {
        const match = /^#(\d+):/u.exec(evidence);
        return match?.[1] ? [[match[1], evidence]] : [];
      }),
    );
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
      const cleanRoomSection = await requestValidatedRewrite(
        {
          prompt,
          section: chunk.section,
          prEvidence: chunkEvidence,
          apiKey,
        },
        version,
        chunk.prNumbers,
      );
      cleanRoomSections.push(cleanRoomSection);
      console.log(`Validated clean-room chunk ${index + 1}/${chunks.length}.`);
    }
    const replacement = mergeCleanRoomSections(cleanRoomSections, version);
    validateReplacement(replacement, version, sourcePrNumbers);
    console.log('Validated merged clean-room release section.');

    // Nothing is written until every chunk and the merged result validate.
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
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
