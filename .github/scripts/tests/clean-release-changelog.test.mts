import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { getGitTestEnvironment } from './git-test-environment.mts';
import {
  assertPrEvidenceAvailable,
  getLocalEvidenceLogArguments,
  getLocalPrEvidence,
  getPrEvidence,
  isRetryableGhApiFailure,
  LiteLlmAuthenticationError,
  isLiteLlmAuthenticationError,
  mergeCleanRoomSections,
  requestCleanRoomRewrite,
  requestGhApiWithRetry,
  requestValidatedRewrite,
  splitReleaseSectionIntoChunks,
  validateReplacement,
} from '../clean-release-changelog.mts';
import {
  extractReleaseSection,
  getEntryPrNumbers,
  getPrNumbers,
  replaceReleaseSection,
} from '../release-section.mts';
import { getEnvironmentWithoutAiKey } from '../shared/environment.mts';

const generatedSection = `## [13.51.0]

### Uncategorized

- Added a new flow (#101)
- Fixed an issue (#102)`;

test('removes LiteLLM credentials from evidence subprocesses', () => {
  assert.deepEqual(
    getEnvironmentWithoutAiKey({
      GH_TOKEN: 'github-token',
      AI_ANALYZER_LITELLM_KEY: 'litellm-key',
    }),
    { GH_TOKEN: 'github-token' },
  );
});

test('retries transient GitHub API failures before returning evidence', async () => {
  let attempts = 0;
  const retryDelays: number[] = [];
  const response = await requestGhApiWithRetry(
    ['repos/MetaMask/metamask-extension/pulls/1'],
    async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error('HTTP 502: Bad Gateway');
      }
      return '{"title":"Recovered"}';
    },
    async (milliseconds) => {
      retryDelays.push(milliseconds);
    },
  );

  assert.equal(response, '{"title":"Recovered"}');
  assert.equal(attempts, 3);
  assert.deepEqual(retryDelays, [1_000, 2_000]);
});

test('does not retry permanent GitHub API failures', async () => {
  let attempts = 0;
  await assert.rejects(
    async () =>
      requestGhApiWithRetry(
        ['repos/MetaMask/metamask-extension/pulls/1'],
        async () => {
          attempts += 1;
          throw new Error('HTTP 404: Not Found');
        },
        async () => {
          throw new Error('Unexpected retry');
        },
      ),
    /HTTP 404/u,
  );
  assert.equal(attempts, 1);
  assert.equal(
    isRetryableGhApiFailure(new Error('HTTP 404: Not Found')),
    false,
  );
  // The command line names the PR, which is not an HTTP status.
  assert.equal(
    isRetryableGhApiFailure(
      new Error(
        'Command failed: gh api repos/o/r/pulls/503\ngh: Not Found (HTTP 404)',
      ),
    ),
    false,
  );
});

test('uses PR title and body when local evidence is unavailable', async () => {
  const requests: string[] = [];
  const evidence = await getPrEvidence(
    'https://github.com/MetaMask/metamask-mobile',
    ['37469'],
    async (argumentsList) => {
      requests.push(argumentsList[0] ?? '');
      if (argumentsList[0]?.endsWith('/pulls/37469')) {
        return JSON.stringify({
          title: 'fix: match the recurring every sheet to expires after',
          body: 'The recurring interval picker now matches the expiration sheet.',
        });
      }
      throw new Error('Unexpected GitHub request');
    },
  );

  assert.deepEqual(evidence.unavailablePrEvidence, []);
  assert.match(
    evidence.evidence[0] ?? '',
    /#37469: fix: match the recurring every sheet/u,
  );
  assert.equal(requests.length, 1);
});

test('collects local evidence only from mainline squash commits', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'local-evidence-'));
  const originalDirectory = process.cwd();
  const git = (...argumentsList: string[]) =>
    execFileSync('git', argumentsList, {
      cwd: directory,
      env: getGitTestEnvironment(),
    });
  const commit = (message: string) =>
    git('commit', '--allow-empty', '-m', message);

  try {
    git('init', '--initial-branch', 'main');
    commit('feat: add thing (#1)\n\nBody one');
    commit('feat: real thing (#4)\n\nReal body');
    commit('Revert "feat: real thing (#4)" (#5)\n\nRevert body');
    commit('chore: backport (#2)\n\nThis is a cherry-pick of another commit.');
    // `origin/main` is what marks a commit as mainline.
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    commit('feat: side branch only (#3)');
    // A newer copy of #1 that is not on main must not hide the mainline one.
    commit('feat: add thing for the release (#1)\n\nRelease copy');

    process.chdir(directory);
    const evidence = await getLocalPrEvidence(['1', '2', '3', '4']);

    // A revert quotes the PR it undoes but is not evidence for that PR.
    assert.deepEqual([...evidence].sort(), [
      ['1', '#1: feat: add thing (#1)\nLocal squash commit body:\nBody one'],
      ['4', '#4: feat: real thing (#4)\nLocal squash commit body:\nReal body'],
    ]);
  } finally {
    process.chdir(originalDirectory);
    rmSync(directory, { force: true, recursive: true });
  }
});

test('falls back to GitHub when local history cannot be read', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'no-repo-'));
  const originalDirectory = process.cwd();
  const warn = context.mock.method(console, 'warn', () => undefined);

  try {
    process.chdir(directory);
    assert.deepEqual([...(await getLocalPrEvidence(['1']))], []);
    assert.equal(warn.mock.callCount(), 1);
  } finally {
    process.chdir(originalDirectory);
    rmSync(directory, { force: true, recursive: true });
  }
});

test('does not query GitHub when local mainline evidence exists', async () => {
  const evidence = await getPrEvidence(
    'https://github.com/MetaMask/metamask-mobile',
    ['37469'],
    async () => {
      throw new Error('GitHub evidence was not expected');
    },
    new Map([
      [
        '37469',
        '#37469: fix: match the recurring every sheet to expires after\nLocal squash commit body:\nThe interval picker now matches.',
      ],
    ]),
  );

  assert.deepEqual(evidence.unavailablePrEvidence, []);
  assert.deepEqual(evidence.evidence, [
    '#37469: fix: match the recurring every sheet to expires after\nLocal squash commit body:\nThe interval picker now matches.',
  ]);
});

test('limits local evidence history to referenced PR numbers', () => {
  assert.deepEqual(getLocalEvidenceLogArguments([]), undefined);
  assert.deepEqual(getLocalEvidenceLogArguments(['37469', '37522', '37469']), [
    'log',
    'HEAD',
    '--extended-regexp',
    '--grep=\\(#(37469|37522)\\)',
    '--format=%H%x1f%s%x1f%b%x1e',
  ]);
});

test('identifies LiteLLM credential rejections', () => {
  const error = new LiteLlmAuthenticationError(401);
  assert.equal(error.name, 'LiteLlmAuthenticationError');
  assert.match(error.message, /HTTP 401/u);
  assert.equal(isLiteLlmAuthenticationError(error), true);
  assert.equal(isLiteLlmAuthenticationError(new Error('HTTP 401')), false);
});

test('cleans large release sections in reference-preserving chunks', () => {
  const section = `## [13.51.0]

### Uncategorized

- Added a new flow (#101)
- Fixed an issue (#102)

### Fixed

- Improved a flow (#103)`;
  assert.deepEqual(splitReleaseSectionIntoChunks(section, '13.51.0', 2), [
    {
      section: `## [13.51.0]

### Uncategorized

- Added a new flow (#101)

- Fixed an issue (#102)`,
      prNumbers: ['101', '102'],
    },
    {
      section: `## [13.51.0]

### Fixed

- Improved a flow (#103)`,
      prNumbers: ['103'],
    },
  ]);
  const merged = mergeCleanRoomSections(
    [
      `## [13.51.0]

### Added

- Added a new flow (#101)

### Fixed

- Fixed an issue (#102)`,
      `## [13.51.0]

### Fixed

- Improved a flow (#103)`,
    ],
    '13.51.0',
  );
  assert.doesNotThrow(() =>
    validateReplacement(merged, '13.51.0', ['101', '102', '103']),
  );
  assert.doesNotMatch(merged, /\)\n\n- /u);
});

test('warns about and skips an identical repeat of an entry', (context) => {
  const warn = context.mock.method(console, 'warn', () => undefined);
  const chunks = splitReleaseSectionIntoChunks(
    `## [13.51.0]

### Fixed

- Fixed an issue (#101)

### Changed

- Fixed an issue (#101)`,
    '13.51.0',
  );

  assert.deepEqual(chunks[0]?.prNumbers, ['101']);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0]?.arguments[0]), /PR 101/u);
});

test('rejects different entries for the same PR instead of dropping one', () => {
  assert.throws(
    () =>
      splitReleaseSectionIntoChunks(
        `## [13.51.0]

### Fixed

- Fixed an issue (#101)
- Fixed another issue (#101)`,
        '13.51.0',
      ),
    /different entries for PR 101/u,
  );
});

test('extracts exactly one release section', () => {
  const changelog = `# Changelog

${generatedSection}

## [13.50.3]

### Fixed

- An earlier fix (#100)
`;

  assert.equal(
    extractReleaseSection(changelog, '13.51.0').section,
    generatedSection,
  );
  assert.deepEqual(getPrNumbers(generatedSection), ['101', '102']);
});

test('counts the PR groups auto-changelog counts', () => {
  assert.deepEqual(
    getPrNumbers(`## [1.0.0]

### Fixed

- Fixed issue #4521 in the send flow (#101, #102).
- Reverted "Fixed it (#67)" (#69)
- Added a flow with no reference`),
    ['101', '102', '67', '69'],
  );
  // auto-changelog reads the first line, wherever the group sits on it.
  assert.deepEqual(
    getEntryPrNumbers('- Fixed it (#7)\n  - nested detail (#8)'),
    ['7'],
  );
  assert.deepEqual(getEntryPrNumbers('- Fixed it (#7), (#8)'), ['7', '8']);
  assert.deepEqual(getEntryPrNumbers('- Fixed swap from (#46000) (#101)'), [
    '46000',
    '101',
  ]);
  assert.deepEqual(getEntryPrNumbers('- (#101)'), ['101']);
});

test('rejects a duplicate release heading', () => {
  assert.throws(
    () =>
      extractReleaseSection(
        `${generatedSection}\n\n${generatedSection}`,
        '13.51.0',
      ),
    /Expected exactly one release heading/u,
  );
});

test('replaces only the release section without changing its surrounding whitespace', () => {
  const changelog = `# Changelog

${generatedSection}

## [13.50.3]

### Fixed

- An earlier fix (#100)
`;
  const replacement = `## [13.51.0]

### Added

- Added a clean flow (#101)

### Fixed

- Fixed an issue (#102)`;

  assert.equal(
    replaceReleaseSection(changelog, '13.51.0', replacement),
    changelog.replace(generatedSection, replacement),
  );
});

test('accepts a categorized replacement that preserves every PR once', () => {
  assert.doesNotThrow(() =>
    validateReplacement(
      `## [13.51.0]

### Added

- Added a new flow (#101)

### Fixed

- Fixed an issue (#102)`,
      '13.51.0',
      ['101', '102'],
    ),
  );
});

test('rejects uncategorized, omitted, invented, and duplicate PR references', () => {
  assert.throws(
    () => validateReplacement(generatedSection, '13.51.0', ['101', '102']),
    /Uncategorized/u,
  );
  assert.throws(
    () =>
      validateReplacement(
        `## [13.51.0]

### Fixed

- Fixed an issue (#101)`,
        '13.51.0',
        ['101', '102'],
      ),
    /references do not match/u,
  );
  assert.throws(
    () =>
      validateReplacement(
        `## [13.51.0]

### Fixed

- Fixed an issue (#101, #102, #103)`,
        '13.51.0',
        ['101', '102'],
      ),
    /references do not match/u,
  );
  assert.throws(
    () =>
      validateReplacement(
        `## [13.51.0]

### Fixed

- Fixed an issue (#101)
- Fixed it again (#101)
- Fixed another issue (#102)`,
        '13.51.0',
        ['101', '102'],
      ),
    /duplicate PR references/u,
  );
  assert.throws(
    () =>
      validateReplacement(
        `## [13.51.0]

Here is the cleaned section:

### Fixed

- Fixed an issue (#101, #102)`,
        '13.51.0',
        ['101', '102'],
      ),
    /unexpected Markdown/u,
  );
  assert.throws(
    () =>
      validateReplacement(
        `## [13.51.0]

### Fixed

- Fixed an issue (#101)- Fixed another issue (#102)`,
        '13.51.0',
        ['101', '102'],
      ),
    /adjacent list items/u,
  );
});

test('rejects an entry without a trailing PR reference', () => {
  assert.throws(
    () =>
      validateReplacement(
        `## [13.51.0]

### Fixed

- Fixed an issue (#101)
- Improved performance across the app`,
        '13.51.0',
        ['101'],
      ),
    /must be text followed by its PR reference/u,
  );
});

test('rejects entries that are not canonical or hide a PR in the text', () => {
  const entry = (line: string) => `## [13.51.0]\n\n### Fixed\n\n${line}`;
  assert.throws(
    () => validateReplacement(entry('- Fixed X (#101).'), '13.51.0', ['101']),
    /must be text followed by its PR reference/u,
  );
  assert.throws(
    () => validateReplacement(entry('- (#101)'), '13.51.0', ['101']),
    /must be text followed by its PR reference/u,
  );
  assert.throws(
    () =>
      validateReplacement(
        entry('- Fixed swap from (#46000) (#101)'),
        '13.51.0',
        ['101'],
      ),
    /references do not match/u,
  );
});

test('accepts dashes and parentheses inside an entry', () => {
  assert.doesNotThrow(() =>
    validateReplacement(
      `## [13.51.0]

### Fixed

- Updated fees (beta) - now shown in fiat (#101)`,
      '13.51.0',
      ['101'],
    ),
  );
});

type FetchResponse = Awaited<ReturnType<typeof fetch>>;
type RecordedRequest = { url: string; init: RequestInit };

/**
 * Builds a minimal fetch response.
 *
 * @param status - The HTTP status.
 * @param body - The JSON body.
 * @returns The response.
 */
function fakeResponse(status: number, body: unknown = {}): FetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as FetchResponse;
}

/**
 * Builds a fake fetch that returns or throws the given results in order.
 *
 * @param responses - The results, consumed one per request.
 * @param requests - Collects each request made.
 * @returns The fake fetch.
 */
function createFetch(
  responses: (FetchResponse | Error)[],
  requests: RecordedRequest[] = [],
): typeof fetch {
  return (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) {
      throw new Error('Unexpected request');
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }) as typeof fetch;
}

/**
 * Builds a successful chat-completions response.
 *
 * @param content - The message content.
 * @returns The response.
 */
function completion(content: unknown): FetchResponse {
  return fakeResponse(200, { choices: [{ message: { content } }] });
}

const rewriteInput = {
  prompt: 'Prompt',
  section: generatedSection,
  prEvidence: ['#101: Title'],
  apiKey: 'litellm-key',
};

/**
 * Puts an environment variable back to its earlier value.
 *
 * @param name - The variable.
 * @param value - Its earlier value, or undefined if it was unset.
 */
function restoreEnvironmentVariable(
  name: string,
  value: string | undefined,
): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

for (const invalidTimeout of ['soon', '0', '3000000000']) {
  test(`rejects the timeout "${invalidTimeout}" in the environment`, async () => {
    const originalTimeout = process.env.CHANGELOG_AI_TIMEOUT_MS;
    restoreEnvironmentVariable('CHANGELOG_AI_TIMEOUT_MS', invalidTimeout);
    try {
      await assert.rejects(
        async () =>
          requestCleanRoomRewrite({
            ...rewriteInput,
            fetchImpl: createFetch([]),
          }),
        /CHANGELOG_AI_TIMEOUT_MS must be a positive integer/u,
      );
    } finally {
      restoreEnvironmentVariable('CHANGELOG_AI_TIMEOUT_MS', originalTimeout);
    }
  });
}

test('sends the pinned model with the bearer credential to chat completions', async () => {
  const requests: RecordedRequest[] = [];
  const result = await requestCleanRoomRewrite({
    ...rewriteInput,
    fetchImpl: createFetch([completion('  ## [13.51.0]  ')], requests),
    sleep: async () => undefined,
    timeoutMs: 1_000,
  });

  assert.equal(result, '## [13.51.0]');
  assert.equal(requests.length, 1);
  assert.match(requests[0]?.url ?? '', /\/chat\/completions$/u);
  assert.equal(requests[0]?.init.method, 'POST');
  const headers = requests[0]?.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer litellm-key');
  const body = JSON.parse(String(requests[0]?.init.body)) as {
    model: string;
    temperature: number;
    messages: { content: string }[];
  };
  assert.equal(body.model, 'gpt-5.6-terra');
  assert.equal(body.temperature, 0);
  assert.match(body.messages[1]?.content ?? '', /<release_section>/u);
  assert.doesNotMatch(JSON.stringify(body), /litellm-key/u);
});

test('does not retry a rejected LiteLLM credential', async () => {
  for (const status of [401, 403]) {
    const requests: RecordedRequest[] = [];
    const sleeps: number[] = [];
    await assert.rejects(
      async () =>
        requestCleanRoomRewrite({
          ...rewriteInput,
          fetchImpl: createFetch([fakeResponse(status)], requests),
          sleep: async (milliseconds) => {
            sleeps.push(milliseconds);
          },
          timeoutMs: 1_000,
        }),
      (error: unknown) =>
        isLiteLlmAuthenticationError(error) &&
        error.message.includes(`HTTP ${String(status)}`),
    );
    assert.equal(requests.length, 1);
    assert.deepEqual(sleeps, []);
  }
});

test('retries one transient LiteLLM failure and then succeeds', async () => {
  const requests: RecordedRequest[] = [];
  const sleeps: number[] = [];
  const result = await requestCleanRoomRewrite({
    ...rewriteInput,
    fetchImpl: createFetch(
      [fakeResponse(503), completion('## [13.51.0]')],
      requests,
    ),
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
    timeoutMs: 1_000,
  });

  assert.equal(result, '## [13.51.0]');
  assert.equal(requests.length, 2);
  assert.deepEqual(sleeps, [1_000]);
});

test('stops after the retry budget for persistent LiteLLM failures', async () => {
  const requests: RecordedRequest[] = [];
  await assert.rejects(
    async () =>
      requestCleanRoomRewrite({
        ...rewriteInput,
        fetchImpl: createFetch(
          [fakeResponse(500), fakeResponse(500)],
          requests,
        ),
        sleep: async () => undefined,
        timeoutMs: 1_000,
      }),
    /LiteLLM returned HTTP 500/u,
  );
  assert.equal(requests.length, 2);
});

test('rejects an empty LiteLLM message after the retry budget', async () => {
  await assert.rejects(
    async () =>
      requestCleanRoomRewrite({
        ...rewriteInput,
        fetchImpl: createFetch([completion(''), completion(null)]),
        sleep: async () => undefined,
        timeoutMs: 1_000,
      }),
    /no message content/u,
  );
});

test('requests another response when one fails validation', async (context) => {
  context.mock.method(console, 'warn', () => undefined);
  const requests: RecordedRequest[] = [];
  const valid = `## [13.51.0]

### Added

- Added a new flow (#101)

### Fixed

- Fixed an issue (#102)`;
  const glued = valid.replace(
    '(#101)\n\n### Fixed\n\n- Fixed',
    '(#101)- Fixed',
  );

  const section = await requestValidatedRewrite(
    {
      ...rewriteInput,
      fetchImpl: createFetch([completion(glued), completion(valid)], requests),
    },
    '13.51.0',
    ['101', '102'],
  );

  assert.equal(section, valid);
  assert.equal(requests.length, 2);
});

test('gives up after the last response fails validation', async (context) => {
  context.mock.method(console, 'warn', () => undefined);
  const requests: RecordedRequest[] = [];
  const invalid = '## [13.51.0]\n\n### Fixed\n\n- Fixed an issue (#101)';

  await assert.rejects(
    async () =>
      requestValidatedRewrite(
        {
          ...rewriteInput,
          fetchImpl: createFetch(
            [completion(invalid), completion(invalid), completion(invalid)],
            requests,
          ),
        },
        '13.51.0',
        ['101', '102'],
      ),
    /references do not match/u,
  );
  assert.equal(requests.length, 3);
});

test('does not request again after a rejected key', async () => {
  const requests: RecordedRequest[] = [];

  await assert.rejects(
    async () =>
      requestValidatedRewrite(
        {
          ...rewriteInput,
          fetchImpl: createFetch([fakeResponse(401)], requests),
        },
        '13.51.0',
        ['101', '102'],
      ),
    LiteLlmAuthenticationError,
  );
  assert.equal(requests.length, 1);
});

test('aborts a LiteLLM request that exceeds the timeout', async () => {
  const signals: (AbortSignal | null | undefined)[] = [];
  const hangingFetch = (async (_url: unknown, init?: RequestInit) => {
    signals.push(init?.signal);
    return new Promise<FetchResponse>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new Error('aborted by timeout'));
      });
    });
  }) as typeof fetch;

  await assert.rejects(
    async () =>
      requestCleanRoomRewrite({
        ...rewriteInput,
        fetchImpl: hangingFetch,
        sleep: async () => undefined,
        timeoutMs: 5,
      }),
    /aborted by timeout/u,
  );
  assert.equal(signals.length, 2);
  assert.equal(
    signals.every((signal) => signal?.aborted),
    true,
  );
});

test('rejects a proofread when any source PR lacks evidence', () => {
  assert.throws(
    () =>
      assertPrEvidenceAvailable([
        { prNumber: '101', error: 'HTTP 404: Not Found' },
        { prNumber: '102', error: 'HTTP 500: Internal Server Error' },
      ]),
    /PR evidence unavailable: #101 \(HTTP 404: Not Found\), #102 \(HTTP 500: Internal Server Error\)/u,
  );
  assert.doesNotThrow(() => assertPrEvidenceAvailable([]));
});

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(
  new URL('../clean-release-changelog.mts', import.meta.url),
);

type ProofreadResult = {
  exitCode: number;
  original: string;
  changelog: string;
  report: Record<string, unknown>;
};

/**
 * Runs the script as a subprocess against a throwaway repository and a local
 * stand-in for LiteLLM. Evidence comes from the repository's mainline commits,
 * so `gh` is never called.
 *
 * @param respond - Writes the stand-in's response to the model request.
 * @returns The exit code, the changelog before and after, and the report.
 */
async function runProofreader(
  respond: (response: ServerResponse) => void,
): Promise<ProofreadResult> {
  const directory = mkdtempSync(join(tmpdir(), 'proofread-'));
  const server = createServer((_request, response) => {
    respond(response);
  });
  const git = (...argumentsList: string[]) =>
    execFileSync('git', argumentsList, {
      cwd: directory,
      env: getGitTestEnvironment(),
    });

  try {
    git('init', '--initial-branch', 'main');
    git('commit', '--allow-empty', '-m', 'feat: add a flow (#101)\n\nBody one');
    git(
      'commit',
      '--allow-empty',
      '-m',
      'fix: fix an issue (#102)\n\nBody two',
    );
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');

    const changelogPath = join(directory, 'CHANGELOG.md');
    const original = `# Changelog\n\n${generatedSection}\n\n## [13.50.3]\n\n### Fixed\n\n- An earlier fix (#100)\n`;
    writeFileSync(changelogPath, original);
    const promptPath = join(directory, 'prompt.md');
    writeFileSync(promptPath, 'Prompt');
    const reportPath = join(directory, 'report.json');

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;

    let exitCode = 0;
    try {
      await execFileAsync(
        process.execPath,
        [
          scriptPath,
          '--changelog',
          changelogPath,
          '--version',
          '13.51.0',
          '--repository',
          'https://github.com/MetaMask/example',
          '--prompt',
          promptPath,
          '--report',
          reportPath,
        ],
        {
          cwd: directory,
          env: {
            ...process.env,
            AI_ANALYZER_LITELLM_KEY: 'litellm-key',
            LITELLM_BASE_URL: `http://127.0.0.1:${port}`,
          },
        },
      );
    } catch (error) {
      exitCode = (error as { code?: number }).code ?? 1;
    }

    return {
      exitCode,
      original,
      changelog: readFileSync(changelogPath, 'utf8'),
      report: JSON.parse(readFileSync(reportPath, 'utf8')),
    };
  } finally {
    server.closeAllConnections();
    server.close();
    rmSync(directory, { force: true, recursive: true });
  }
}

/**
 * Replies with a chat-completions body.
 *
 * @param content - The message content.
 * @returns A responder for `runProofreader`.
 */
function respondWithContent(content: string) {
  return (response: ServerResponse) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  };
}

test('writes the validated section and reports success', async () => {
  const section = `## [13.51.0]

### Added

- Added a new flow (#101)

### Fixed

- Fixed an issue (#102)`;
  const result = await runProofreader(respondWithContent(section));

  assert.equal(result.exitCode, 0);
  assert.equal(result.report.status, 'succeeded');
  assert.equal(
    result.changelog,
    result.original.replace(generatedSection, section),
  );
});

test('leaves the changelog untouched when the model invents an entry', async () => {
  const result = await runProofreader(
    respondWithContent(`## [13.51.0]

### Added

- Added a new flow (#101)
- Improved performance across the app

### Fixed

- Fixed an issue (#102)`),
  );

  assert.equal(result.exitCode, 1);
  assert.equal(result.report.status, 'failed');
  assert.equal(result.report.stage, 'cleaning');
  assert.match(String(result.report.error), /must be text followed by its PR/u);
  assert.equal(result.changelog, result.original);
});

test('leaves the changelog untouched when LiteLLM rejects the key', async () => {
  const result = await runProofreader((response) => {
    response.statusCode = 401;
    response.end('{}');
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.report.stage, 'authentication');
  assert.equal(result.changelog, result.original);
});
