import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { extractReleaseSection } from '../clean-release-changelog.mts';
import {
  findReleaseVersionsContainingPrs,
  getAutoChangelogCli,
  getChangelogValidationArguments,
  getChangelogPushArguments,
  getChangelogPrPresentation,
  getHistoricalSkippedPrNumbers,
  isReleaseSectionEmpty,
  mergeCurrentReleaseSection,
  parseUpdateChangelogArguments,
  validateGeneratedReleaseSection,
  writeFailedProofreadingReport,
} from '../update-release-changelog.mts';

test('records the failure stage in the proofread report', () => {
  const directory = mkdtempSync(join(tmpdir(), 'proofread-report-'));
  try {
    const reportPath = join(directory, 'nested', 'report.json');
    writeFailedProofreadingReport(reportPath, 'no key', 'authentication');
    assert.deepEqual(JSON.parse(readFileSync(reportPath, 'utf8')), {
      status: 'failed',
      stage: 'authentication',
      error: 'no key',
    });
    writeFailedProofreadingReport(reportPath, 'boom');
    assert.equal(
      (JSON.parse(readFileSync(reportPath, 'utf8')) as { stage: string }).stage,
      'execution',
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test('collects historical skipped PRs from auto-changelog diagnostics', () => {
  assert.deepEqual(
    getHistoricalSkippedPrNumbers(`[auto-changelog] skipped pr=35695 reason=historical-pr
[auto-changelog] commit=abc accepted source-pr=1 canonical-pr=1 cherry-pick=false
[auto-changelog] skipped pr=35716 reason=historical-pr
[auto-changelog] skipped pr=35695 reason=historical-pr
[auto-changelog] skipped pr=9 reason=cherry-pick-duplicate`),
    ['35695', '35716'],
  );
  assert.deepEqual(getHistoricalSkippedPrNumbers(''), []);
});

test('finds the releases that already list a PR, oldest first, excluding the target', () => {
  const changelog = `# Changelog

## [Unreleased]

- Mentions #35716 outside a release

## [8.11.0]

### Added

- Added a notice (#35716)
- Updated dependencies ([#35695](https://example.test/pull/35695))

## [8.10.3]

## [8.9.0]

- Added an older feature (#35695)

## [8.8.0]

- Unrelated (#1)
`;
  assert.deepEqual(
    findReleaseVersionsContainingPrs(changelog, ['35695', '35716'], '8.10.3'),
    ['8.9.0', '8.11.0'],
  );
  assert.deepEqual(
    findReleaseVersionsContainingPrs(changelog, ['35716'], '8.11.0'),
    [],
  );
});

test('detects a release section without entries', () => {
  assert.equal(
    isReleaseSectionEmpty(
      '# Changelog\n\n## [8.10.3]\n\n## [8.10.2]\n',
      '8.10.3',
    ),
    true,
  );
  assert.equal(
    isReleaseSectionEmpty(
      '# Changelog\n\n## [8.10.3]\n\n### Fixed\n\n- Fixed it (#1)\n\n## [8.10.2]\n',
      '8.10.3',
    ),
    false,
  );
});

test('asks for a manual edit when an OTA release has no new PRs', () => {
  assert.deepEqual(
    getChangelogPrPresentation({
      version: '8.10.3',
      changelogBranch: 'release-changelog/8.10.3',
      previousVersionRef: 'null',
      proofreadingStatus: 'no-new-prs',
      presentInVersions: ['8.11.0', '8.12.0'],
    }),
    {
      title:
        'release: release-changelog/8.10.3 (no new PRs, manual edit required)',
      body: 'This PR updates the change log for 8.10.3. (Hotfix - no test plan generated.)\n\n> There are no brand new PRs in 8.10.3, there are only cherry-picks that were already present in 8.11.0, 8.12.0. Please decide how you want to handle this and edit the changelog manually.',
    },
  );
  assert.match(
    getChangelogPrPresentation({
      version: '8.10.3',
      changelogBranch: 'release-changelog/8.10.3',
      previousVersionRef: 'x',
      proofreadingStatus: 'no-new-prs',
    }).body,
    /There are no brand new PRs in 8\.10\.3\. Please decide/u,
  );
});

test('parses dry-run without changing positional arguments', () => {
  assert.deepEqual(
    parseUpdateChangelogArguments([
      '--dry-run',
      'release/13.51.0',
      'extension',
      'https://github.com/MetaMask/metamask-extension',
      'null',
    ]),
    {
      dryRun: true,
      positionalArguments: [
        'release/13.51.0',
        'extension',
        'https://github.com/MetaMask/metamask-extension',
        'null',
      ],
    },
  );
});

test('requires a pinned auto-changelog source CLI', () => {
  assert.equal(
    getAutoChangelogCli({ AUTO_CHANGELOG_CLI: '/tmp/auto-changelog.mjs' }),
    '/tmp/auto-changelog.mjs',
  );
  assert.throws(
    () => getAutoChangelogCli({}),
    /AUTO_CHANGELOG_CLI must point/u,
  );
});

test('uses the standard validator when clean-room proofreading fails', () => {
  assert.deepEqual(getChangelogValidationArguments('failed'), [
    'validate',
    '--prettier',
  ]);
  assert.deepEqual(getChangelogValidationArguments('succeeded'), [
    'validate',
    '--prettier',
    '--rc',
  ]);
});

test('preserves the reviewed release section above historical predecessor history', () => {
  assert.equal(
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
    `# Changelog

## [13.51.0]

### Added

- Added a current release feature (#101)

## [13.50.0]

### Fixed

- Fixed an earlier issue (#100)
`,
  );
});

test('inserts the reviewed release section after the preamble and Unreleased heading', () => {
  assert.equal(
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
    `# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [13.51.0]

### Added

- Added a current release feature (#101)

## [13.50.0]

### Fixed

- Fixed an earlier issue (#100)
`,
  );
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

  assert.equal(
    merged,
    stableShapedChangelog.replace(
      '## [13.50.0]',
      `${reviewedSection}\n\n## [13.50.0]`,
    ),
  );
  assert.equal(
    extractReleaseSection(merged, '13.51.0').section,
    reviewedSection,
  );
  assert.ok(merged.indexOf('## [Unreleased]') < merged.indexOf('## [13.51.0]'));
  assert.ok(merged.indexOf('## [13.51.0]') < merged.indexOf('## [13.50.0]'));
});

test('keeps CRLF line endings when merging into a CRLF changelog', () => {
  const merged = mergeCurrentReleaseSection({
    changelog: stableShapedChangelog.replaceAll('\n', '\r\n'),
    currentReleaseSection: reviewedSection,
    version: '13.51.0',
  });

  assert.equal(merged.replaceAll('\r\n', '').includes('\n'), false);
  assert.ok(merged.includes('## [13.51.0]\r\n\r\n### Added'));
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

  assert.equal(twice.match(/^## \[13\.51\.0\]$/gmu)?.length, 1);
  assert.match(twice, /\(#102\)/u);
  assert.doesNotMatch(twice, /\(#101\)/u);
});

test('appends the reviewed section when the changelog has no releases yet', () => {
  const merged = mergeCurrentReleaseSection({
    changelog: '# Changelog\n\n## [Unreleased]\n',
    currentReleaseSection: reviewedSection,
    version: '13.51.0',
  });

  assert.equal(
    merged,
    `# Changelog\n\n## [Unreleased]\n\n${reviewedSection}\n`,
  );
});

test('rejects a changelog without the Changelog heading', () => {
  assert.throws(
    () =>
      mergeCurrentReleaseSection({
        changelog: '## [13.50.0]\n',
        currentReleaseSection: reviewedSection,
        version: '13.51.0',
      }),
    /must begin with a Changelog heading/u,
  );
});

test('protects first changelog branch creation with an empty lease', () => {
  assert.deepEqual(
    getChangelogPushArguments({
      changelogBranch: 'release-changelog/13.51.0',
      expectedRemoteSha: undefined,
    }),
    [
      'push',
      '--force-with-lease=refs/heads/release-changelog/13.51.0:',
      '--set-upstream',
      'origin',
      'HEAD:refs/heads/release-changelog/13.51.0',
    ],
  );
});

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

test('preserves authentication failures for the unproofread PR warning', () => {
  const authenticationFailure = {
    status: 'failed' as const,
    stage: 'authentication',
  };
  assert.deepEqual(
    getChangelogPrPresentation({
      version: '13.51.0',
      changelogBranch: 'release-changelog/13.51.0',
      previousVersionRef: 'null',
      proofreadingStatus: authenticationFailure.status,
      proofreadingStage: authenticationFailure.stage,
    }).title,
    'release: release-changelog/13.51.0 (AI automation failed, not proofread)',
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
