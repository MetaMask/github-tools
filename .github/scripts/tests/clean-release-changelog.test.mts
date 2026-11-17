import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';

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
import { getGitTestEnvironment } from './git-test-environment.mts';

describe('clean-release-changelog', () => {
  const generatedSection = `## [13.51.0]

### Uncategorized

- Added a new flow (#101)
- Fixed an issue (#102)`;

  it('removes LiteLLM credentials from evidence subprocesses', () => {
    expect(
      getEnvironmentWithoutAiKey({
        GH_TOKEN: 'github-token',
        AI_ANALYZER_LITELLM_KEY: 'litellm-key',
      }),
    ).toStrictEqual({ GH_TOKEN: 'github-token' });
  });

  it('retries transient GitHub API failures before returning evidence', async () => {
    const request = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('HTTP 502: Bad Gateway'))
      .mockRejectedValueOnce(new Error('HTTP 502: Bad Gateway'))
      .mockResolvedValue('{"title":"Recovered"}');
    const retryDelays: number[] = [];
    const response = await requestGhApiWithRetry(
      ['repos/MetaMask/metamask-extension/pulls/1'],
      request,
      async (milliseconds) => {
        retryDelays.push(milliseconds);
      },
    );

    expect(response).toBe('{"title":"Recovered"}');
    expect(request).toHaveBeenCalledTimes(3);
    expect(retryDelays).toStrictEqual([1_000, 2_000]);
  });

  it('does not retry permanent GitHub API failures', async () => {
    const request = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new Error('HTTP 404: Not Found'));
    await expect(
      requestGhApiWithRetry(
        ['repos/MetaMask/metamask-extension/pulls/1'],
        request,
        async (): Promise<void> => {
          throw new Error('Unexpected retry');
        },
      ),
    ).rejects.toThrow(/HTTP 404/u);
    expect(request).toHaveBeenCalledTimes(1);
    expect(isRetryableGhApiFailure(new Error('HTTP 404: Not Found'))).toBe(
      false,
    );
    // The command line names the PR, which is not an HTTP status.
    expect(
      isRetryableGhApiFailure(
        new Error(
          'Command failed: gh api repos/o/r/pulls/503\ngh: Not Found (HTTP 404)',
        ),
      ),
    ).toBe(false);
  });

  it('uses PR title and body when local evidence is unavailable', async () => {
    const requests: string[] = [];
    const evidence = await getPrEvidence(
      'https://github.com/MetaMask/metamask-mobile',
      ['37469'],
      async (argumentsList) => {
        requests.push(argumentsList[0] as string);
        return JSON.stringify({
          title: 'fix: match the recurring every sheet to expires after',
          body: 'The recurring interval picker now matches the expiration sheet.',
        });
      },
    );

    expect(evidence.unavailablePrEvidence).toStrictEqual([]);
    expect(evidence.evidence[0]).toMatch(
      /#37469: fix: match the recurring every sheet/u,
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatch(/\/pulls\/37469$/u);
  });

  it('collects local evidence only from mainline squash commits', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'local-evidence-'));
    const originalDirectory = process.cwd();
    const git = (...argumentsList: string[]): Buffer =>
      execFileSync('git', argumentsList, {
        cwd: directory,
        env: getGitTestEnvironment(),
      });
    const commit = (message: string): Buffer =>
      git('commit', '--allow-empty', '-m', message);

    try {
      git('init', '--initial-branch', 'main');
      commit('feat: add thing (#1)\n\nBody one');
      commit('feat: real thing (#4)\n\nReal body');
      commit('Revert "feat: real thing (#4)" (#5)\n\nRevert body');
      commit(
        'chore: backport (#2)\n\nThis is a cherry-pick of another commit.',
      );
      // `origin/main` is what marks a commit as mainline.
      git('update-ref', 'refs/remotes/origin/main', 'HEAD');
      commit('feat: side branch only (#3)');
      // A newer copy of #1 that is not on main must not hide the mainline one.
      commit('feat: add thing for the release (#1)\n\nRelease copy');

      process.chdir(directory);
      const evidence = await getLocalPrEvidence(['1', '2', '3', '4']);

      // A revert quotes the PR it undoes but is not evidence for that PR.
      expect([...evidence].sort()).toStrictEqual([
        ['1', '#1: feat: add thing (#1)\nLocal squash commit body:\nBody one'],
        [
          '4',
          '#4: feat: real thing (#4)\nLocal squash commit body:\nReal body',
        ],
      ]);
    } finally {
      process.chdir(originalDirectory);
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it('falls back to GitHub when local history cannot be read', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'no-repo-'));
    const originalDirectory = process.cwd();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      process.chdir(directory);
      expect([...(await getLocalPrEvidence(['1']))]).toStrictEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      process.chdir(originalDirectory);
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it('does not query GitHub when local mainline evidence exists', async () => {
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

    expect(evidence.unavailablePrEvidence).toStrictEqual([]);
    expect(evidence.evidence).toStrictEqual([
      '#37469: fix: match the recurring every sheet to expires after\nLocal squash commit body:\nThe interval picker now matches.',
    ]);
  });

  it('limits local evidence history to referenced PR numbers', () => {
    expect(getLocalEvidenceLogArguments([])).toBeUndefined();
    expect(
      getLocalEvidenceLogArguments(['37469', '37522', '37469']),
    ).toStrictEqual([
      'log',
      'HEAD',
      '--extended-regexp',
      '--grep=\\(#(37469|37522)\\)',
      '--format=%H%x1f%s%x1f%b%x1e',
    ]);
  });

  it('identifies LiteLLM credential rejections', () => {
    const error = new LiteLlmAuthenticationError(401);
    expect(error.name).toBe('LiteLlmAuthenticationError');
    expect(error.message).toMatch(/HTTP 401/u);
    expect(isLiteLlmAuthenticationError(error)).toBe(true);
    expect(isLiteLlmAuthenticationError(new Error('HTTP 401'))).toBe(false);
  });

  it('cleans large release sections in reference-preserving chunks', () => {
    const section = `## [13.51.0]

### Uncategorized

- Added a new flow (#101)
- Fixed an issue (#102)

### Fixed

- Improved a flow (#103)`;
    expect(splitReleaseSectionIntoChunks(section, '13.51.0', 2)).toStrictEqual([
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
    expect(() =>
      validateReplacement(merged, '13.51.0', ['101', '102', '103']),
    ).not.toThrow();
    expect(merged).not.toMatch(/\)\n\n- /u);
  });

  it('warns about and skips an identical repeat of an entry', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const chunks = splitReleaseSectionIntoChunks(
      `## [13.51.0]

### Fixed

- Fixed an issue (#101)

### Changed

- Fixed an issue (#101)`,
      '13.51.0',
    );

    expect(chunks[0]?.prNumbers).toStrictEqual(['101']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/PR 101/u);
  });

  it('rejects different entries for the same PR instead of dropping one', () => {
    expect(() =>
      splitReleaseSectionIntoChunks(
        `## [13.51.0]

### Fixed

- Fixed an issue (#101)
- Fixed another issue (#101)`,
        '13.51.0',
      ),
    ).toThrow(/different entries for PR 101/u);
  });

  it('extracts exactly one release section', () => {
    const changelog = `# Changelog

${generatedSection}

## [13.50.3]

### Fixed

- An earlier fix (#100)
`;

    expect(extractReleaseSection(changelog, '13.51.0').section).toBe(
      generatedSection,
    );
    expect(getPrNumbers(generatedSection)).toStrictEqual(['101', '102']);
  });

  it('counts the PR groups auto-changelog counts', () => {
    expect(
      getPrNumbers(`## [1.0.0]

### Fixed

- Fixed issue #4521 in the send flow (#101, #102).
- Reverted "Fixed it (#67)" (#69)
- Added a flow with no reference`),
    ).toStrictEqual(['101', '102', '67', '69']);
    // auto-changelog reads the first line, wherever the group sits on it.
    expect(
      getEntryPrNumbers('- Fixed it (#7)\n  - nested detail (#8)'),
    ).toStrictEqual(['7']);
    expect(getEntryPrNumbers('- Fixed it (#7), (#8)')).toStrictEqual([
      '7',
      '8',
    ]);
    expect(
      getEntryPrNumbers('- Fixed swap from (#46000) (#101)'),
    ).toStrictEqual(['46000', '101']);
    expect(getEntryPrNumbers('- (#101)')).toStrictEqual(['101']);
  });

  it('rejects a duplicate release heading', () => {
    expect(() =>
      extractReleaseSection(
        `${generatedSection}\n\n${generatedSection}`,
        '13.51.0',
      ),
    ).toThrow(/Expected exactly one release heading/u);
  });

  it('replaces only the release section without changing its surrounding whitespace', () => {
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

    expect(replaceReleaseSection(changelog, '13.51.0', replacement)).toBe(
      changelog.replace(generatedSection, replacement),
    );
  });

  it('accepts a categorized replacement that preserves every PR once', () => {
    expect(() =>
      validateReplacement(
        `## [13.51.0]

### Added

- Added a new flow (#101)

### Fixed

- Fixed an issue (#102)`,
        '13.51.0',
        ['101', '102'],
      ),
    ).not.toThrow();
  });

  it('rejects uncategorized, omitted, invented, and duplicate PR references', () => {
    expect(() =>
      validateReplacement(generatedSection, '13.51.0', ['101', '102']),
    ).toThrow(/Uncategorized/u);
    expect(() =>
      validateReplacement(
        `## [13.51.0]

### Fixed

- Fixed an issue (#101)`,
        '13.51.0',
        ['101', '102'],
      ),
    ).toThrow(/references do not match/u);
    expect(() =>
      validateReplacement(
        `## [13.51.0]

### Fixed

- Fixed an issue (#101, #102, #103)`,
        '13.51.0',
        ['101', '102'],
      ),
    ).toThrow(/references do not match/u);
    expect(() =>
      validateReplacement(
        `## [13.51.0]

### Fixed

- Fixed an issue (#101)
- Fixed it again (#101)
- Fixed another issue (#102)`,
        '13.51.0',
        ['101', '102'],
      ),
    ).toThrow(/duplicate PR references/u);
    expect(() =>
      validateReplacement(
        `## [13.51.0]

Here is the cleaned section:

### Fixed

- Fixed an issue (#101, #102)`,
        '13.51.0',
        ['101', '102'],
      ),
    ).toThrow(/unexpected Markdown/u);
    expect(() =>
      validateReplacement(
        `## [13.51.0]

### Fixed

- Fixed an issue (#101)- Fixed another issue (#102)`,
        '13.51.0',
        ['101', '102'],
      ),
    ).toThrow(/adjacent list items/u);
  });

  it('rejects an entry without a trailing PR reference', () => {
    expect(() =>
      validateReplacement(
        `## [13.51.0]

### Fixed

- Fixed an issue (#101)
- Improved performance across the app`,
        '13.51.0',
        ['101'],
      ),
    ).toThrow(/must be text followed by its PR reference/u);
  });

  it('rejects entries that are not canonical or hide a PR in the text', () => {
    const entry = (line: string): string =>
      `## [13.51.0]\n\n### Fixed\n\n${line}`;
    expect(() =>
      validateReplacement(entry('- Fixed X (#101).'), '13.51.0', ['101']),
    ).toThrow(/must be text followed by its PR reference/u);
    expect(() =>
      validateReplacement(entry('- (#101)'), '13.51.0', ['101']),
    ).toThrow(/must be text followed by its PR reference/u);
    expect(() =>
      validateReplacement(
        entry('- Fixed swap from (#46000) (#101)'),
        '13.51.0',
        ['101'],
      ),
    ).toThrow(/references do not match/u);
  });

  it('accepts dashes and parentheses inside an entry', () => {
    expect(() =>
      validateReplacement(
        `## [13.51.0]

### Fixed

- Updated fees (beta) - now shown in fiat (#101)`,
        '13.51.0',
        ['101'],
      ),
    ).not.toThrow();
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
   * Reads the URL string out of a fetch input.
   *
   * @param url - The first argument given to fetch.
   * @returns The URL as a string.
   */
  function getRequestUrl(url: Parameters<typeof fetch>[0]): string {
    if (url instanceof URL) {
      return url.href;
    }
    return url instanceof Request ? url.url : url;
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
    return async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      requests.push({
        url: getRequestUrl(url),
        init: init ?? {},
      });
      const next = responses.shift();
      if (!next) {
        throw new Error('Unexpected request');
      }
      if (next instanceof Error) {
        throw next;
      }
      return next;
    };
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
    it(`rejects the timeout "${invalidTimeout}" in the environment`, async () => {
      const originalTimeout = process.env.CHANGELOG_AI_TIMEOUT_MS;
      restoreEnvironmentVariable('CHANGELOG_AI_TIMEOUT_MS', invalidTimeout);
      try {
        await expect(
          requestCleanRoomRewrite({
            ...rewriteInput,
            fetchImpl: createFetch([]),
          }),
        ).rejects.toThrow(
          /CHANGELOG_AI_TIMEOUT_MS must be a positive integer/u,
        );
      } finally {
        restoreEnvironmentVariable('CHANGELOG_AI_TIMEOUT_MS', originalTimeout);
      }
    });
  }

  it('sends the pinned model with the bearer credential to chat completions', async () => {
    const requests: RecordedRequest[] = [];
    const result = await requestCleanRoomRewrite({
      ...rewriteInput,
      fetchImpl: createFetch([completion('  ## [13.51.0]  ')], requests),
      sleep: async () => undefined,
      timeoutMs: 1_000,
    });

    expect(result).toBe('## [13.51.0]');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toMatch(/\/chat\/completions$/u);
    expect(requests[0]?.init.method).toBe('POST');
    const headers = requests[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer litellm-key');
    const body = JSON.parse(requests[0]?.init.body as string) as {
      model: string;
      temperature: number;
      messages: { content: string }[];
    };
    expect(body.model).toBe('gpt-6.1-terra');
    expect(body.temperature).toBe(0);
    expect(body.messages[1]?.content).toMatch(/<release_section>/u);
    expect(JSON.stringify(body)).not.toMatch(/litellm-key/u);
  });

  it('does not retry a rejected LiteLLM credential', async () => {
    for (const status of [401, 403]) {
      const requests: RecordedRequest[] = [];
      const sleeps: number[] = [];
      const rewrite = requestCleanRoomRewrite({
        ...rewriteInput,
        fetchImpl: createFetch([fakeResponse(status)], requests),
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
        },
        timeoutMs: 1_000,
      });
      await expect(rewrite).rejects.toThrow(LiteLlmAuthenticationError);
      await expect(rewrite).rejects.toThrow(`HTTP ${String(status)}`);
      expect(requests).toHaveLength(1);
      expect(sleeps).toStrictEqual([]);
    }
  });

  it('retries one transient LiteLLM failure and then succeeds', async () => {
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

    expect(result).toBe('## [13.51.0]');
    expect(requests).toHaveLength(2);
    expect(sleeps).toStrictEqual([1_000]);
  });

  it('stops after the retry budget for persistent LiteLLM failures', async () => {
    const requests: RecordedRequest[] = [];
    await expect(
      requestCleanRoomRewrite({
        ...rewriteInput,
        fetchImpl: createFetch(
          [fakeResponse(500), fakeResponse(500)],
          requests,
        ),
        sleep: async () => undefined,
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(/LiteLLM returned HTTP 500/u);
    expect(requests).toHaveLength(2);
  });

  it('rejects an empty LiteLLM message after the retry budget', async () => {
    await expect(
      requestCleanRoomRewrite({
        ...rewriteInput,
        fetchImpl: createFetch([completion(''), completion(null)]),
        sleep: async () => undefined,
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(/no message content/u);
  });

  it('requests another response when one fails validation', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
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
        fetchImpl: createFetch(
          [completion(glued), completion(valid)],
          requests,
        ),
      },
      '13.51.0',
      ['101', '102'],
    );

    expect(section).toBe(valid);
    expect(requests).toHaveLength(2);
  });

  it('gives up after the last response fails validation', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const requests: RecordedRequest[] = [];
    const invalid = '## [13.51.0]\n\n### Fixed\n\n- Fixed an issue (#101)';

    await expect(
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
    ).rejects.toThrow(/references do not match/u);
    expect(requests).toHaveLength(3);
  });

  it('does not request again after a rejected key', async () => {
    const requests: RecordedRequest[] = [];

    await expect(
      requestValidatedRewrite(
        {
          ...rewriteInput,
          fetchImpl: createFetch([fakeResponse(401)], requests),
        },
        '13.51.0',
        ['101', '102'],
      ),
    ).rejects.toThrow(LiteLlmAuthenticationError);
    expect(requests).toHaveLength(1);
  });

  it('aborts a LiteLLM request that exceeds the timeout', async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    const hangingFetch = (async (_url: unknown, init?: RequestInit) => {
      signals.push(init?.signal);
      return await new Promise<FetchResponse>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('aborted by timeout'));
        });
      });
    }) as typeof fetch;

    await expect(
      requestCleanRoomRewrite({
        ...rewriteInput,
        fetchImpl: hangingFetch,
        sleep: async () => undefined,
        timeoutMs: 5,
      }),
    ).rejects.toThrow(/aborted by timeout/u);
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal?.aborted)).toBe(true);
  });

  it('rejects a proofread when any source PR lacks evidence', () => {
    expect(() =>
      assertPrEvidenceAvailable([
        { prNumber: '101', error: 'HTTP 404: Not Found' },
        { prNumber: '102', error: 'HTTP 500: Internal Server Error' },
      ]),
    ).toThrow(
      /PR evidence unavailable: #101 \(HTTP 404: Not Found\), #102 \(HTTP 500: Internal Server Error\)/u,
    );
    expect(() => assertPrEvidenceAvailable([])).not.toThrow();
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
    const git = (...argumentsList: string[]): Buffer =>
      execFileSync('git', argumentsList, {
        cwd: directory,
        env: getGitTestEnvironment(),
      });

    try {
      git('init', '--initial-branch', 'main');
      git(
        'commit',
        '--allow-empty',
        '-m',
        'feat: add a flow (#101)\n\nBody one',
      );
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
    return (response: ServerResponse): void => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ choices: [{ message: { content } }] }));
    };
  }

  it('writes the validated section and reports success', async () => {
    const section = `## [13.51.0]

### Added

- Added a new flow (#101)

### Fixed

- Fixed an issue (#102)`;
    const result = await runProofreader(respondWithContent(section));

    expect(result.exitCode).toBe(0);
    expect(result.report.status).toBe('succeeded');
    expect(result.changelog).toBe(
      result.original.replace(generatedSection, section),
    );
  });

  it('leaves the changelog untouched when the model invents an entry', async () => {
    const result = await runProofreader(
      respondWithContent(`## [13.51.0]

### Added

- Added a new flow (#101)
- Improved performance across the app

### Fixed

- Fixed an issue (#102)`),
    );

    expect(result.exitCode).toBe(1);
    expect(result.report.status).toBe('failed');
    expect(result.report.stage).toBe('cleaning');
    expect(String(result.report.error)).toMatch(
      /must be text followed by its PR/u,
    );
    expect(result.changelog).toBe(result.original);
  });

  it('leaves the changelog untouched when LiteLLM rejects the key', async () => {
    const result = await runProofreader((response) => {
      response.statusCode = 401;
      response.end('{}');
    });

    expect(result.exitCode).toBe(1);
    expect(result.report.stage).toBe('authentication');
    expect(result.changelog).toBe(result.original);
  });
});
