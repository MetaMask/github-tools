import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getChangelogPrPresentation,
  validateGeneratedReleaseSection,
} from '../update-release-changelog.mts';

test('marks an unproofread changelog PR when AI proofreading fails', () => {
  assert.deepEqual(
    getChangelogPrPresentation({
      version: '13.51.0',
      changelogBranch: 'release-changelog/13.51.0',
      previousVersionRef: 'null',
      proofreadingStatus: 'failed',
      proofreadingStage: 'authentication',
    }),
    {
      title:
        'release: release-changelog/13.51.0 (AI automation failed, not proofread)',
      body: 'This PR updates the change log for 13.51.0. (Hotfix - no test plan generated.)\n\n> AI automation failed during authentication, not proofread. The deterministic changelog generation, reference validation, and changelog lint passed. Review the release section manually before merging.',
    },
  );
});

test('clears the AI failure presentation after a successful proofread', () => {
  assert.deepEqual(
    getChangelogPrPresentation({
      version: '13.51.0',
      changelogBranch: 'release-changelog/13.51.0',
      previousVersionRef: 'null',
      proofreadingStatus: 'succeeded',
    }),
    {
      title: 'release: release-changelog/13.51.0',
      body: 'This PR updates the change log for 13.51.0. (Hotfix - no test plan generated.)',
    },
  );
});

test('rejects generated sections with missing or duplicate PR references', () => {
  assert.throws(
    () =>
      validateGeneratedReleaseSection(
        `## [13.51.0]

### Fixed

- Fixed an issue`,
        '13.51.0',
      ),
    /without a PR reference/u,
  );
  assert.throws(
    () =>
      validateGeneratedReleaseSection(
        `## [13.51.0]

### Fixed

- Fixed an issue (#101)
- Fixed it again (#101)`,
        '13.51.0',
      ),
    /duplicate PR references/u,
  );
  assert.doesNotThrow(() =>
    validateGeneratedReleaseSection(
      `## [13.51.0]

### Fixed

- Fixed an issue (#101)
- Fixed it again (#101)`,
      '13.51.0',
      true,
    ),
  );
});
