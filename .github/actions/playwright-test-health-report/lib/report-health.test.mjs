import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateBucketSlots,
  formatWatchHistory,
  partitionSummary,
} from './classify-report-buckets.mjs';
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
    assert.equal(test.latestClassification, 'passed');
    assert.equal(test.historicalBrokenCount, 1);
    assert.equal(test.historicalFlakyCount, 1);
    assert.equal(test.totalRuns, 3);
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

    assert.equal(watchItems.length, 1);
    assert.equal(flakyItems.length, 0);
    assert.equal(brokenItems.length, 0);
  });
});

describe('allocateBucketSlots', () => {
  it('gives spare capacity to watch when nothing is currently broken', () => {
    const slots = allocateBucketSlots(15, { broken: 0, flaky: 0, watch: 13, infra: 0 });

    assert.equal(slots.maxBroken, 0);
    assert.equal(slots.maxWatch, 13);
    assert.equal(slots.maxBroken + slots.maxFlaky + slots.maxWatch + slots.maxInfra, 13);
  });
});

describe('formatWatchHistory', () => {
  it('includes both broken and flaky history', () => {
    const text = formatWatchHistory({
      historicalBrokenCount: 2,
      historicalFlakyCount: 3,
      totalRuns: 8,
    });

    assert.match(text, /broken 2\/8 runs/);
    assert.match(text, /flaky 3\/8 runs/);
  });
});
