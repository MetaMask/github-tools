import assert from 'node:assert/strict';
import test from 'node:test';

import {
  selectChangelogBaseline,
  type ChangelogBaselineDependencies,
} from '../update-release-changelog-baseline.mts';

function createDependencies({
  headings = new Set<string>(),
  stableVersions = [],
  releaseBranches = [],
  openPrNumber,
}: {
  headings?: Set<string>;
  stableVersions?: string[];
  releaseBranches?: { version: string; kind: 'native' | 'ota'; name: string }[];
  openPrNumber?: string;
}): ChangelogBaselineDependencies {
  return {
    hasReleaseHeading: (ref, version) => headings.has(`${ref}:${version}`),
    getOpenChangelogPrNumber: () => openPrNumber,
    getStableVersions: () => stableVersions,
    getReleaseBranches: () => releaseBranches,
  };
}

function selectBaseline(
  dependencies: ChangelogBaselineDependencies,
  changelogBranchSha?: string,
) {
  return selectChangelogBaseline({
    version: '13.51.0',
    releaseBranch: 'release/13.51.0',
    changelogBranch: 'release-changelog/13.51.0',
    changelogBranchSha,
    dependencies,
  });
}

test('uses the target release changelog after the changelog PR is merged', () => {
  assert.deepEqual(
    selectBaseline(
      createDependencies({
        headings: new Set(['origin/release/13.51.0:13.51.0']),
      }),
    ),
    {
      kind: 'target',
      ref: 'origin/release/13.51.0',
      version: '13.51.0',
    },
  );
});

test('uses an open changelog PR branch for a pre-merge rerun', () => {
  assert.deepEqual(
    selectBaseline(
      createDependencies({
        headings: new Set(['origin/release-changelog/13.51.0:13.51.0']),
        openPrNumber: '12345',
      }),
      'abc123',
    ),
    {
      kind: 'changelog',
      ref: 'origin/release-changelog/13.51.0',
      version: '13.51.0',
    },
  );
});

test('prefers stable for the selected predecessor version', () => {
  assert.deepEqual(
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
    { kind: 'stable', ref: 'origin/stable', version: '13.50.3' },
  );
});

test('uses the highest predecessor release branch when stable is behind', () => {
  assert.deepEqual(
    selectBaseline(
      createDependencies({
        headings: new Set(['origin/stable:13.50.2']),
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
    {
      kind: 'release',
      ref: 'origin/release/13.50.3',
      version: '13.50.3',
    },
  );
});

test('rejects ambiguous native and OTA predecessor branches', () => {
  assert.throws(
    () =>
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
    /Expected exactly one release branch/u,
  );
});
