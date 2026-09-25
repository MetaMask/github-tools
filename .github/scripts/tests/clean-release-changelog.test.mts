import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractReleaseSection,
  getPrNumbers,
  replaceReleaseSection,
  validateReplacement,
} from '../clean-release-changelog.mts';

const generatedSection = `## [13.51.0]

### Uncategorized

- Added a new flow (#101)
- Fixed an issue (#102)`;

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
});
