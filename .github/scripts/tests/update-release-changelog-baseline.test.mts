import { expect, test } from 'vitest';

import {
  removeNewerReleases,
  selectChangelogBaseline,
  type ChangelogBaselineDependencies,
} from '../update-release-changelog-baseline.mts';

/**
 * Builds fake Git lookups for the baseline tests.
 *
 * @param options0 - The options.
 * @param options0.headings - The `ref:version` pairs that have a heading.
 * @param options0.stableVersions - The versions in the `stable` changelog.
 * @param options0.releaseBranches - The release branches on origin.
 * @returns The fake dependencies.
 */
function createDependencies({
  headings = new Set<string>(),
  stableVersions = [],
  releaseBranches = [],
}: {
  headings?: Set<string>;
  stableVersions?: string[];
  releaseBranches?: { version: string; kind: 'native' | 'ota'; name: string }[];
}): ChangelogBaselineDependencies {
  return {
    hasReleaseHeading: (ref, version) => headings.has(`${ref}:${version}`),
    getStableVersions: () => stableVersions,
    getReleaseBranches: () => releaseBranches,
  };
}

/**
 * Selects the baseline for version 13.51.0 on its release branch.
 *
 * @param dependencies - The fake Git lookups.
 * @returns The selected baseline.
 */
function selectBaseline(dependencies: ChangelogBaselineDependencies) {
  return selectChangelogBaseline({
    version: '13.51.0',
    releaseBranch: 'release/13.51.0',
    dependencies,
  });
}

test('uses the target release changelog after the changelog PR is merged', () => {
  expect(
    selectBaseline(
      createDependencies({
        headings: new Set(['origin/release/13.51.0:13.51.0']),
      }),
    ),
  ).toStrictEqual({
    kind: 'target',
    ref: 'origin/release/13.51.0',
    version: '13.51.0',
  });
});

test('uses stable history even when an open changelog PR is reviewed', () => {
  expect(
    selectBaseline(
      createDependencies({
        headings: new Set(['origin/stable:13.50.0']),
        stableVersions: ['13.50.0'],
      }),
    ),
  ).toStrictEqual({
    kind: 'stable',
    ref: 'origin/stable',
    version: '13.50.0',
  });
});

test('prefers stable for the selected predecessor version', () => {
  expect(
    selectBaseline(
      createDependencies({
        headings: new Set(['origin/stable:13.50.3']),
        stableVersions: ['13.50.2', '13.50.3'],
        releaseBranches: [
          {
            version: '13.50.3',
            kind: 'native',
            name: 'release/13.50.3',
          },
        ],
      }),
    ),
  ).toStrictEqual({ kind: 'stable', ref: 'origin/stable', version: '13.50.3' });
});

test('uses the highest predecessor release branch when stable is behind', () => {
  expect(
    selectBaseline(
      createDependencies({
        headings: new Set([
          'origin/stable:13.50.2',
          'origin/release/13.50.3:13.50.3',
        ]),
        stableVersions: ['13.50.2'],
        releaseBranches: [
          {
            version: '13.50.2',
            kind: 'native',
            name: 'release/13.50.2',
          },
          {
            version: '13.50.3',
            kind: 'native',
            name: 'release/13.50.3',
          },
        ],
      }),
    ),
  ).toStrictEqual({
    kind: 'release',
    ref: 'origin/release/13.50.3',
    version: '13.50.3',
  });
});

test('rejects a predecessor release branch whose changelog lacks its own section', () => {
  expect(() =>
    selectBaseline(
      createDependencies({
        headings: new Set(['origin/stable:13.50.2']),
        stableVersions: ['13.50.2'],
        releaseBranches: [
          {
            version: '13.50.3',
            kind: 'native',
            name: 'release/13.50.3',
          },
        ],
      }),
    ),
  ).toThrow(
    /origin\/release\/13\.50\.3 has no ## \[13\.50\.3\] changelog section/u,
  );
});

const stableChangelog = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '## [13.51.0]',
  '',
  '### Added',
  '',
  '- Added c (#3)',
  '',
  '## [13.50.3]',
  '',
  '### Added',
  '',
  '- Added b (#2)',
  '',
  '[Unreleased]: https://example.com/compare/v13.51.0...HEAD',
  '[13.51.0]: https://example.com/compare/v13.50.3...v13.51.0',
  '[13.50.3]: https://example.com/releases/tag/v13.50.3',
  '',
].join('\n');

test('drops releases newer than an older-line hotfix with their link references', () => {
  expect(removeNewerReleases(stableChangelog, '13.50.4')).toBe(
    [
      '# Changelog',
      '',
      '## [Unreleased]',
      '',
      '## [13.50.3]',
      '',
      '### Added',
      '',
      '- Added b (#2)',
      '',
      '[Unreleased]: https://example.com/compare/v13.51.0...HEAD',
      '[13.50.3]: https://example.com/releases/tag/v13.50.3',
      '',
    ].join('\n'),
  );
});

test('leaves a changelog without newer releases byte for byte', () => {
  expect(removeNewerReleases(stableChangelog, '13.51.0')).toBe(stableChangelog);
  expect(removeNewerReleases(stableChangelog, '14.0.0')).toBe(stableChangelog);
});

test('keeps CRLF line endings when dropping newer releases', () => {
  const crlf = stableChangelog.replaceAll('\n', '\r\n');

  expect(removeNewerReleases(crlf, '13.50.4').includes('\r\r')).toBe(false);
  expect(removeNewerReleases(crlf, '13.50.4').includes('13.51.0]')).toBe(false);
  expect(removeNewerReleases(crlf, '13.50.4').split('\r\n').length).toBe(
    removeNewerReleases(crlf, '13.50.4').split('\n').length,
  );
});

test('rejects ambiguous native and OTA predecessor branches', () => {
  expect(() =>
    selectBaseline(
      createDependencies({
        releaseBranches: [
          {
            version: '13.50.3',
            kind: 'native',
            name: 'release/13.50.3',
          },
          {
            version: '13.50.3',
            kind: 'ota',
            name: 'release/13.50.3-ota',
          },
        ],
      }),
    ),
  ).toThrow(/Expected exactly one release branch/u);
});
