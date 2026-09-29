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

test('rejects a proofread when any source PR lacks evidence', () => {
  assert.throws(
    () => assertPrEvidenceAvailable(['101', '102']),
    /PR evidence unavailable for #101, #102/u,
  );
  assert.doesNotThrow(() => assertPrEvidenceAvailable([]));
});
