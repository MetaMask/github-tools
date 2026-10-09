import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertPrEvidenceAvailable,
  extractReleaseSection,
  getEvidenceEnvironment,
  getPrNumbers,
  isRetryableGhApiFailure,
  LiteLlmAuthenticationError,
  isLiteLlmAuthenticationError,
  mergeCleanRoomSections,
  requestCleanRoomRewrite,
  requestGhApiWithRetry,
  replaceReleaseSection,
  splitReleaseSectionIntoChunks,
  validateReplacement,
} from '../clean-release-changelog.mts';

const generatedSection = `## [13.51.0]

### Uncategorized

- Added a new flow (#101)
- Fixed an issue (#102)`;

test('removes LiteLLM credentials from evidence subprocesses', () => {
  assert.deepEqual(
    getEvidenceEnvironment({
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

### Uncategorized

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

type FetchResponse = Awaited<ReturnType<typeof fetch>>;
type RecordedRequest = { url: string; init: RequestInit };

function fakeResponse(status: number, body: unknown = {}): FetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as FetchResponse;
}

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

function completion(content: unknown): FetchResponse {
  return fakeResponse(200, { choices: [{ message: { content } }] });
}

const rewriteInput = {
  prompt: 'Prompt',
  section: generatedSection,
  prEvidence: ['#101: Title'],
  apiKey: 'litellm-key',
};

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
    () => assertPrEvidenceAvailable(['101', '102']),
    /PR evidence unavailable for #101, #102/u,
  );
  assert.doesNotThrow(() => assertPrEvidenceAvailable([]));
});
