import { describe, expect, it } from 'vitest';

import {
  allocateBucketSlots,
  formatWatchHistory,
  partitionSummary,
} from './classify-report-buckets.mjs';
import { normalizeRepoFilePath } from './normalize-repo-file-path.mjs';
import { createSlackBlocks } from './slack-test-health-blocks.mjs';
import { summarizeTestHealth } from './summarize-test-health.mjs';

describe('summarizeTestHealth', () => {
  it('keeps historical counts when latest run passed', () => {
    const summary = summarizeTestHealth([
      {
        key: 'ios::file.spec.ts::deletes account',
        name: 'deletes account',
        path: 'file.spec.ts',
        projectName: 'ios-smoke',
        classification: 'broken',
        retries: 1,
        error: 'timeout',
        runId: '1',
        runUrl: 'https://example.com/1',
        date: new Date('2026-06-16T10:00:00Z'),
      },
      {
        key: 'ios::file.spec.ts::deletes account',
        name: 'deletes account',
        path: 'file.spec.ts',
        projectName: 'ios-smoke',
        classification: 'flaky',
        retries: 1,
        error: 'timeout',
        runId: '2',
        runUrl: 'https://example.com/2',
        date: new Date('2026-06-16T12:00:00Z'),
      },
      {
        key: 'ios::file.spec.ts::deletes account',
        name: 'deletes account',
        path: 'file.spec.ts',
        projectName: 'ios-smoke',
        classification: 'passed',
        retries: 0,
        error: '',
        runId: '3',
        runUrl: 'https://example.com/3',
        date: new Date('2026-06-17T10:00:00Z'),
      },
    ]);

    const test = summary[0];
    expect(test.latestClassification).toBe('passed');
    expect(test.historicalBrokenCount).toBe(1);
    expect(test.historicalFlakyCount).toBe(1);
    expect(test.totalRuns).toBe(3);
  });
});

describe('partitionSummary', () => {
  it('puts passed tests with flaky history into watch', () => {
    const { watchItems, flakyItems, brokenItems } = partitionSummary([
      {
        latestClassification: 'passed',
        historicalBrokenCount: 0,
        historicalFlakyCount: 4,
        brokenCount: 0,
        flakyCount: 4,
        totalRuns: 10,
        name: 'exports srp',
      },
    ]);

    expect(watchItems.length).toBe(1);
    expect(flakyItems.length).toBe(0);
    expect(brokenItems.length).toBe(0);
  });
});

describe('allocateBucketSlots', () => {
  it('gives spare capacity to watch when nothing is currently broken', () => {
    const slots = allocateBucketSlots(15, {
      broken: 0,
      flaky: 0,
      watch: 13,
      infra: 0,
    });

    expect(slots.maxBroken).toBe(0);
    expect(slots.maxWatch).toBe(13);
    expect(
      slots.maxBroken + slots.maxFlaky + slots.maxWatch + slots.maxInfra,
    ).toBe(13);
  });
});

describe('formatWatchHistory', () => {
  it('includes both broken and flaky history', () => {
    const text = formatWatchHistory({
      historicalBrokenCount: 2,
      historicalFlakyCount: 3,
      totalRuns: 8,
    });

    expect(text).toMatch(/failed 2\/8 runs/);
    expect(text).toMatch(/flaky 3\/8 runs/);
  });
});

describe('normalizeRepoFilePath', () => {
  it('prefixes testDir-relative paths', () => {
    expect(
      normalizeRepoFilePath(
        'accounts/account-syncing-settings-toggle.spec.ts',
        {
          prefix: 'tests/smoke-appium',
        },
      ),
    ).toBe(
      'tests/smoke-appium/accounts/account-syncing-settings-toggle.spec.ts',
    );
  });

  it('strips CI absolute checkout paths to repo-relative', () => {
    expect(
      normalizeRepoFilePath(
        '/Users/runner/work/metamask-mobile/metamask-mobile/tests/framework/config/global.setup.ts',
      ),
    ).toBe('tests/framework/config/global.setup.ts');
  });

  it('leaves paths already under tests/ unchanged when prefix is set', () => {
    expect(
      normalizeRepoFilePath('tests/smoke-appium/accounts/foo.spec.ts', {
        prefix: 'tests/smoke-appium',
      }),
    ).toBe('tests/smoke-appium/accounts/foo.spec.ts');
  });

  it('does not double-apply an identical prefix', () => {
    expect(
      normalizeRepoFilePath('tests/smoke-appium/accounts/foo.spec.ts', {
        prefix: 'tests/smoke-appium',
      }),
    ).toBe('tests/smoke-appium/accounts/foo.spec.ts');
  });

  it('returns relative paths unchanged when no prefix is set', () => {
    expect(normalizeRepoFilePath('accounts/foo.spec.ts')).toBe(
      'accounts/foo.spec.ts',
    );
  });
});

describe('createSlackBlocks path links', () => {
  it('builds blob URLs with normalized repo-relative paths', () => {
    const blocks = createSlackBlocks(
      [
        {
          name: 'toggles sync',
          path: 'accounts/account-syncing-settings-toggle.spec.ts',
          projectName: 'ios',
          latestClassification: 'broken',
          historicalBrokenCount: 1,
          historicalFlakyCount: 0,
          historicalInfraCount: 0,
          brokenCount: 1,
          flakyCount: 0,
          infraCount: 0,
          totalRuns: 1,
          lastBrokenError: 'timeout',
          lastBrokenRunUrl:
            'https://github.com/MetaMask/metamask-mobile/actions/runs/1',
        },
      ],
      '2026-06-24',
      {
        owner: 'MetaMask',
        repository: 'metamask-mobile',
        branch: 'main',
        reportTitle: 'Playwright Test Health Report',
        topN: 15,
        workflowsScanned: ['ci.yml'],
        workflowCount: 1,
        testFailureRunCount: 1,
        otherFailedRunCount: 0,
        lookbackDays: 1,
        testSourcePrefix: 'tests/smoke-appium',
      },
    );

    const link = blocks
      .flatMap((block) => block.elements || [])
      .flatMap((element) => element.elements || [])
      .find(
        (element) => element.type === 'link' && element.text === 'toggles sync',
      );

    expect(link?.url).toBe(
      'https://github.com/MetaMask/metamask-mobile/blob/main/tests/smoke-appium/accounts/account-syncing-settings-toggle.spec.ts',
    );
  });
});
