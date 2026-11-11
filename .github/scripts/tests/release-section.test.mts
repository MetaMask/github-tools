import { expect, test } from 'vitest';

import {
  extractReleaseSection,
  getNewReleaseEntriesSection,
  mergeCurrentReleaseSection,
  mergeNewReleaseEntries,
  normalizeRepositoryPrLinks,
  removeReleaseEntries,
  replaceReleaseSection,
  restoreGeneratedCategories,
} from '../release-section.mts';

test('finds the heading line even when its text appears earlier', () => {
  const changelog =
    '<!-- ## [1.0.0] -->\n\n## [1.0.0]\n\n- Real entry (#1)\n\n## [0.9.0]\n';

  expect(extractReleaseSection(changelog, '1.0.0').section).toBe(
    '## [1.0.0]\n\n- Real entry (#1)',
  );
});

test('writes a replacement in the changelog line endings', () => {
  const changelog = '## [1.0.0]\r\n\r\n- Old (#1)\r\n\r\n## [0.9.0]\r\n';

  expect(
    replaceReleaseSection(changelog, '1.0.0', '## [1.0.0]\n\n- New (#1)'),
  ).toBe('## [1.0.0]\r\n\r\n- New (#1)\r\n\r\n## [0.9.0]\r\n');
});

test('isolates newly generated entries without changing the existing release section', () => {
  const existingSection = `## [13.51.0]

### Added

- Added an existing feature (#101)

### Fixed

- Fixed an existing issue (#102)`;
  const generatedSection = `## [13.51.0]

### Added

- Reworded existing feature (#101)
- Added a new feature (#103)

### Fixed

- Reworded existing issue (#102)`;

  const newEntriesSection = getNewReleaseEntriesSection({
    existingSection,
    generatedSection,
    version: '13.51.0',
  });

  expect(newEntriesSection).toBe(`## [13.51.0]

### Added

- Added a new feature (#103)`);
  expect(
    mergeNewReleaseEntries({
      existingSection,
      newEntriesSection: newEntriesSection ?? '',
      version: '13.51.0',
    }),
  ).toBe(`## [13.51.0]

### Added

- Added a new feature (#103)
- Added an existing feature (#101)

### Fixed

- Fixed an existing issue (#102)`);
});

test('merges new entries into matching categories and inserts missing ones in canonical order', () => {
  const existingSection = `## [13.51.0]

### Added

- Added an existing feature (#101)

### Fixed

- Fixed an existing issue (#102)
  with a continuation line`;

  expect(
    mergeNewReleaseEntries({
      existingSection,
      newEntriesSection: `## [13.51.0]

### Changed

- Changed a thing (#103)

### Fixed

- Fixed a new issue (#104)

### Security

- Hardened a thing (#105)`,
      version: '13.51.0',
    }),
  ).toBe(`## [13.51.0]

### Added

- Added an existing feature (#101)

### Changed

- Changed a thing (#103)

### Fixed

- Fixed a new issue (#104)
- Fixed an existing issue (#102)
  with a continuation line

### Security

- Hardened a thing (#105)`);
});

test('restores the generator category when the proofread wording has no known verb', () => {
  expect(
    restoreGeneratedCategories({
      generatedSection: `## [1.0.0]\n\n### Added\n\n- Added a (#1)\n\n### Fixed\n\n- Fixed b (#2)\n\n### Uncategorized\n\n- Did c (#3)\n\n### Fixed\n\n- Fixed d (#4)`,
      cleanedSection: `## [1.0.0]\n\n### Changed\n\n- Improved a (#1)\n- Improved c (#3)\n- Merged d and b (#2, #4)`,
      version: '1.0.0',
    }),
  ).toBe(
    `## [1.0.0]\n\n### Added\n\n- Improved a (#1)\n\n### Changed\n\n- Improved c (#3)\n\n### Fixed\n\n- Merged d and b (#2, #4)`,
  );
});

test('files an entry under the category its wording implies', () => {
  expect(
    restoreGeneratedCategories({
      generatedSection: `## [1.0.0]\n\n### Removed\n\n- Removed a bar (#1)\n\n### Fixed\n\n- Fixed a crash (#2)`,
      cleanedSection: `## [1.0.0]\n\n### Removed\n\n- Fixed the bar layout (#1)\n\n### Fixed\n\n- Added support for X (#2)`,
      version: '1.0.0',
    }),
  ).toBe(
    `## [1.0.0]\n\n### Added\n\n- Added support for X (#2)\n\n### Fixed\n\n- Fixed the bar layout (#1)`,
  );
});

test("shortens only this repository's long PR links", () => {
  const repositoryUrl = 'https://github.com/MetaMask/metamask-mobile';
  expect(
    normalizeRepositoryPrLinks(
      [
        '- Own link ([#1](https://github.com/MetaMask/metamask-mobile/pull/1))',
        '- Two links ([#2](https://github.com/MetaMask/metamask-mobile/pull/2), [#3](https://github.com/MetaMask/metamask-mobile/pull/3))',
        '- Legacy groups ([#4](https://github.com/MetaMask/metamask-mobile/pull/4)), ([#5](https://github.com/MetaMask/metamask-mobile/pull/5))',
        '- Other repo ([#6](https://github.com/MetaMask/core/pull/6))',
        '- Already short (#7)',
      ].join('\r\n'),
      repositoryUrl,
    ),
  ).toBe(
    [
      '- Own link (#1)',
      '- Two links (#2, #3)',
      '- Legacy groups (#4, #5)',
      '- Other repo ([#6](https://github.com/MetaMask/core/pull/6))',
      '- Already short (#7)',
    ].join('\r\n'),
  );
});

test('treats a long-link entry in the existing section as documented', () => {
  expect(
    getNewReleaseEntriesSection({
      existingSection: `## [1.0.0]\n\n### Added\n\n- Added a ([#1](https://github.com/MetaMask/metamask-mobile/pull/1))`,
      generatedSection: `## [1.0.0]\n\n### Added\n\n- Added a (#1)\n- Added b (#2)`,
      version: '1.0.0',
      repositoryUrl: 'https://github.com/MetaMask/metamask-mobile',
    }),
  ).toBe(`## [1.0.0]\n\n### Added\n\n- Added b (#2)`);
});

test('matches an existing entry that has trailing whitespace', () => {
  expect(
    getNewReleaseEntriesSection({
      existingSection: '## [1.0.0]\n\n### Added\n\n- Added a  \n',
      generatedSection: '## [1.0.0]\n\n### Added\n\n- Added a\n- Added b (#2)',
      version: '1.0.0',
    }),
  ).toBe('## [1.0.0]\n\n### Added\n\n- Added b (#2)');
});

test('leaves out a PR a reviewer deleted', () => {
  expect(
    getNewReleaseEntriesSection({
      existingSection: '## [1.0.0]\n\n### Added\n\n- Added a (#1)',
      generatedSection:
        '## [1.0.0]\n\n### Added\n\n- Added a (#1)\n- Added b (#2)\n- Added c (#3)',
      version: '1.0.0',
      deletedPrNumbers: new Set(['2']),
    }),
  ).toBe('## [1.0.0]\n\n### Added\n\n- Added c (#3)');
});

test('keeps the existing line ending when merging new entries', () => {
  expect(
    mergeNewReleaseEntries({
      existingSection: '## [1.0.0]\r\n\r\n### Fixed\r\n\r\n- Old (#1)\r\n',
      newEntriesSection: '## [1.0.0]\n\n### Added\n\n- New (#2)',
      version: '1.0.0',
    }),
  ).toBe(
    '## [1.0.0]\r\n\r\n### Added\r\n\r\n- New (#2)\r\n\r\n### Fixed\r\n\r\n- Old (#1)',
  );
});

test('finds no new release entries when every generated PR is already documented', () => {
  expect(
    getNewReleaseEntriesSection({
      existingSection: `## [13.51.0]

### Fixed

- Fixed an existing issue (#101)`,
      generatedSection: `## [13.51.0]

### Fixed

- Reworded existing issue (#101)`,
      version: '13.51.0',
    }),
  ).toBe(undefined);
});

test('judges a generated entry by its last PR reference and demotes earlier mentions', () => {
  const existingSection = `## [13.51.0]

### Fixed

- Fixed an existing issue (#101)`;

  expect(
    getNewReleaseEntriesSection({
      existingSection,
      generatedSection: `## [13.51.0]

### Fixed

- Fixed a regression from (#101) and #100 (#102)
  see also #101`,
      version: '13.51.0',
    }),
  ).toBe(`## [13.51.0]

### Fixed

- Fixed a regression from PR 101 and PR 100 (#102)
  see also PR 101`);
  expect(
    getNewReleaseEntriesSection({
      existingSection,
      generatedSection: `## [13.51.0]

### Fixed

- Reworded a documented PR that mentions (#102) (#101)`,
      version: '13.51.0',
    }),
  ).toBe(undefined);
});

test('keeps a multi-PR group intact and demotes mentions before it', () => {
  const existingSection = `## [13.51.0]

### Fixed

- Fixed an existing issue (#101)`;
  const generatedSection = (entry: string) =>
    `## [13.51.0]

### Fixed

${entry}`;

  expect(
    getNewReleaseEntriesSection({
      existingSection,
      generatedSection: generatedSection(
        '- Fixed a regression from #100 (#102, #103)',
      ),
      version: '13.51.0',
    }),
  ).toBe(generatedSection('- Fixed a regression from PR 100 (#102, #103)'));
  expect(
    getNewReleaseEntriesSection({
      existingSection,
      generatedSection: generatedSection(
        '- Fixed legacy groups (#102), (#103)',
      ),
      version: '13.51.0',
    }),
  ).toBe(generatedSection('- Fixed legacy groups (#102), (#103)'));
});

test('skips a grouped generated entry when any PR in its group is documented', () => {
  const existingSection = `## [13.51.0]\n\n### Fixed\n\n- Fixed an existing issue (#101)`;

  expect(
    getNewReleaseEntriesSection({
      existingSection,
      generatedSection: `## [13.51.0]\n\n### Fixed\n\n- Fixed an issue (#101, #102)`,
      version: '13.51.0',
    }),
  ).toBe(undefined);
  expect(
    getNewReleaseEntriesSection({
      existingSection,
      generatedSection: `## [13.51.0]\n\n### Fixed\n\n- Fixed an issue (#102, #103)`,
      version: '13.51.0',
      deletedPrNumbers: new Set(['103']),
    }),
  ).toBe(undefined);
});

test('preserves the reviewed release section above historical predecessor history', () => {
  expect(
    mergeCurrentReleaseSection({
      changelog: `# Changelog

## [13.50.0]

### Fixed

- Fixed an earlier issue (#100)
`,
      currentReleaseSection: `## [13.51.0]

### Added

- Added a current release feature (#101)`,
      version: '13.51.0',
    }),
  ).toBe(`# Changelog

## [13.51.0]

### Added

- Added a current release feature (#101)

## [13.50.0]

### Fixed

- Fixed an earlier issue (#100)
`);
});

test('inserts the reviewed release section after the preamble and Unreleased heading', () => {
  expect(
    mergeCurrentReleaseSection({
      changelog: `# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [13.50.0]

### Fixed

- Fixed an earlier issue (#100)
`,
      currentReleaseSection: `## [13.51.0]

### Added

- Added a current release feature (#101)`,
      version: '13.51.0',
    }),
  ).toBe(`# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [13.51.0]

### Added

- Added a current release feature (#101)

## [13.50.0]

### Fixed

- Fixed an earlier issue (#100)
`);
});

const stableShapedChangelog = `# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [13.50.0]

### Fixed

- Fixed an earlier issue ([#100](https://github.com/MetaMask/metamask-extension/pull/100))

## [13.49.0]

### Added

- Added an older feature ([#90](https://github.com/MetaMask/metamask-extension/pull/90))

[Unreleased]: https://github.com/MetaMask/metamask-extension/compare/v13.50.0...HEAD
[13.50.0]: https://github.com/MetaMask/metamask-extension/compare/v13.49.0...v13.50.0
[13.49.0]: https://github.com/MetaMask/metamask-extension/releases/tag/v13.49.0
`;

const reviewedSection = `## [13.51.0]

### Added

- Added a current release feature (#101)`;

test('merges into a stable-shaped changelog without disturbing history or link references', () => {
  const merged = mergeCurrentReleaseSection({
    changelog: stableShapedChangelog,
    currentReleaseSection: reviewedSection,
    version: '13.51.0',
  });

  expect(merged).toBe(
    stableShapedChangelog.replace(
      '## [13.50.0]',
      `${reviewedSection}\n\n## [13.50.0]`,
    ),
  );
  expect(extractReleaseSection(merged, '13.51.0').section).toBe(
    reviewedSection,
  );
  expect(
    merged.indexOf('## [Unreleased]') < merged.indexOf('## [13.51.0]'),
  ).toBeTruthy();
  expect(
    merged.indexOf('## [13.51.0]') < merged.indexOf('## [13.50.0]'),
  ).toBeTruthy();
});

test('keeps CRLF line endings when merging into a CRLF changelog', () => {
  const merged = mergeCurrentReleaseSection({
    changelog: stableShapedChangelog.replaceAll('\n', '\r\n'),
    currentReleaseSection: reviewedSection,
    version: '13.51.0',
  });

  expect(merged.replaceAll('\r\n', '').includes('\n')).toBe(false);
  expect(merged.includes('## [13.51.0]\r\n\r\n### Added')).toBeTruthy();
});

test('replaces an existing current heading instead of duplicating it', () => {
  const once = mergeCurrentReleaseSection({
    changelog: stableShapedChangelog,
    currentReleaseSection: reviewedSection,
    version: '13.51.0',
  });
  const twice = mergeCurrentReleaseSection({
    changelog: once,
    currentReleaseSection: reviewedSection.replace('(#101)', '(#102)'),
    version: '13.51.0',
  });

  expect(twice.match(/^## \[13\.51\.0\]$/gmu)?.length).toBe(1);
  expect(twice).toMatch(/\(#102\)/u);
  expect(twice).not.toMatch(/\(#101\)/u);
});

test('appends the reviewed section when the changelog has no releases yet', () => {
  const merged = mergeCurrentReleaseSection({
    changelog: '# Changelog\n\n## [Unreleased]\n',
    currentReleaseSection: reviewedSection,
    version: '13.51.0',
  });

  expect(merged).toBe(`# Changelog\n\n## [Unreleased]\n\n${reviewedSection}\n`);
});

test('does not double carriage returns when inserting a CRLF section into a CRLF changelog', () => {
  const merged = mergeCurrentReleaseSection({
    changelog: '# Changelog\r\n\r\n## [Unreleased]\r\n\r\n## [13.50.0]\r\n',
    currentReleaseSection:
      '## [13.51.0]\r\n\r\n### Added\r\n\r\n- Added it (#1)',
    version: '13.51.0',
  });

  expect(merged.includes('\r\r')).toBe(false);
  expect(merged).toBe(
    '# Changelog\r\n\r\n## [Unreleased]\r\n\r\n## [13.51.0]\r\n\r\n### Added\r\n\r\n- Added it (#1)\r\n\r\n## [13.50.0]\r\n',
  );
});

test('keeps a reviewer entry without a PR reference out of the new entries', () => {
  const existingSection = [
    '## [1.0.0]',
    '',
    '### Added',
    '',
    '- Updated translations',
    '- Added a thing (#1)',
    '',
    '### Fixed',
    '',
    '- Fixed a thing (#1)',
  ].join('\n');
  const generatedSection = existingSection.replace(
    '- Added a thing (#1)',
    '- Added a thing (#1)\n- Added another thing (#2)',
  );

  expect(
    getNewReleaseEntriesSection({
      existingSection,
      generatedSection,
      version: '1.0.0',
    }),
  ).toBe('## [1.0.0]\n\n### Added\n\n- Added another thing (#2)');
});

test('still rejects a generated entry without a PR reference', () => {
  expect(() =>
    getNewReleaseEntriesSection({
      existingSection: '## [1.0.0]\n\n### Added\n\n- Added a thing (#1)',
      generatedSection:
        '## [1.0.0]\n\n### Added\n\n- Added a thing (#1)\n- Mystery entry',
      version: '1.0.0',
    }),
  ).toThrow(/lacks a PR reference/u);
});

test('rejects a changelog without the Changelog heading', () => {
  expect(() =>
    mergeCurrentReleaseSection({
      changelog: '## [13.50.0]\n',
      currentReleaseSection: reviewedSection,
      version: '13.51.0',
    }),
  ).toThrow(/must begin with a Changelog heading/u);
});

test('ends the oldest release section before the link references', () => {
  const changelog = [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    '## [13.51.0]',
    '',
    '### Fixed',
    '',
    '- Fixed an issue (#101)',
    '',
    '[Unreleased]: https://example.com/HEAD',
    '[13.51.0]: https://example.com/13.51.0',
    '',
  ].join('\n');

  expect(extractReleaseSection(changelog, '13.51.0').section).toBe(
    '## [13.51.0]\n\n### Fixed\n\n- Fixed an issue (#101)',
  );
  expect(
    replaceReleaseSection(
      changelog,
      '13.51.0',
      '## [13.51.0]\n\n### Added\n\n- Added a feature (#102)',
    ),
  ).toBe(
    changelog
      .replace('### Fixed', '### Added')
      .replace('Fixed an issue (#101)', 'Added a feature (#102)'),
  );
});

test('removes the entries owning the given PRs and drops emptied categories', () => {
  const section = [
    '## [2.0.0]',
    '',
    '### Added',
    '',
    '- Added a thing (#1)',
    '',
    '### Fixed',
    '',
    '- Fixed one (#2)',
    '  more detail',
    '- Fixed two (#3)',
  ].join('\n');

  expect(
    removeReleaseEntries({ section, prNumbers: new Set(['1', '2']) }),
  ).toBe(['## [2.0.0]', '', '### Fixed', '', '- Fixed two (#3)'].join('\n'));
  expect(
    removeReleaseEntries({ section, prNumbers: new Set(['1', '2', '3']) }),
  ).toBe('## [2.0.0]');
});

test('keeps an entry that owns a PR outside the given PRs', () => {
  const section = [
    '## [2.0.0]',
    '',
    '### Fixed',
    '',
    '- Fixed from (#1) (#2)',
    '- Fixed together (#3, #4)',
  ].join('\n');

  expect(
    removeReleaseEntries({ section, prNumbers: new Set(['1', '3']) }),
  ).toBe(section);
  expect(
    removeReleaseEntries({ section, prNumbers: new Set(['3', '4']) }),
  ).toBe(
    ['## [2.0.0]', '', '### Fixed', '', '- Fixed from (#1) (#2)'].join('\n'),
  );
});

test('leaves the section untouched when no entry matches', () => {
  const section = '## [2.0.0]\n\n### Added\n\n- Added a thing (#1)';

  expect(removeReleaseEntries({ section, prNumbers: new Set(['9']) })).toBe(
    section,
  );
});
