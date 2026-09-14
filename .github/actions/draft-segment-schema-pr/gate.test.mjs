import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AGREEMENT_PHRASE,
  CATALOG_FILES,
  MAX_CHANGED_TS_FILES,
  botBranchName,
  collectTsDiff,
  decideGate,
  eventSkipReason,
  hasAnalyticsDiff,
  isAgreementComment,
  shouldPushSchema,
} from './gate.mjs';

const PR = {
  number: 12,
  isFork: false,
  hasOptOutLabel: false,
  isOpen: true,
  merged: false,
  authorLogin: 'alice',
};

/**
 * Builds decideGate input with overrides.
 *
 * @param {object} overrides - Partial input.
 * @returns {object} Full input.
 */
function input(overrides = {}) {
  return {
    mode: 'propose',
    eventName: 'pull_request',
    eventAction: 'synchronize',
    pr: PR,
    commentBody: '',
    commenterLogin: '',
    schemaPrExists: false,
    hasProposalComment: false,
    pullFiles: [
      {
        filename: 'app/Home.ts',
        patch: '+createEventBuilder(MetaMetricsEvents.APP_OPENED)',
      },
    ],
    platform: 'mobile',
    ...overrides,
  };
}

describe('eventSkipReason', () => {
  it('skips propose on issue_comment and close unless the PR closed', () => {
    assert.equal(
      eventSkipReason('propose', 'issue_comment', 'created'),
      'wrong-event',
    );
    assert.equal(
      eventSkipReason('propose', 'pull_request', 'closed'),
      'wrong-event',
    );
    assert.equal(
      eventSkipReason('close', 'pull_request', 'synchronize'),
      'wrong-event',
    );
    assert.equal(eventSkipReason('create', 'issue_comment', 'created'), '');
    assert.equal(eventSkipReason('propose', 'pull_request', 'synchronize'), '');
    assert.equal(eventSkipReason('close', 'pull_request', 'closed'), '');
  });
});

describe('isAgreementComment', () => {
  it('treats trailing whitespace on the agreement sentence as a match', () => {
    assert.equal(
      isAgreementComment(`${AGREEMENT_PHRASE}  \nThanks`, 'alice', 'alice'),
      true,
    );
    assert.equal(isAgreementComment(AGREEMENT_PHRASE, 'bob', 'alice'), false);
    assert.equal(isAgreementComment('please open it', 'alice', 'alice'), false);
  });
});

describe('collectTsDiff and hasAnalyticsDiff', () => {
  it('keeps non-test TypeScript paths and detects analytics patches', () => {
    const diff = collectTsDiff([
      {
        filename: 'app/Home.ts',
        patch: '+createEventBuilder(MetaMetricsEvents.APP_OPENED)',
      },
      { filename: 'README.md', patch: '+docs' },
      { filename: 'app/foo.test.ts', patch: '+createEventBuilder(x)' },
    ]);
    assert.deepEqual(diff.files, ['app/Home.ts']);
    assert.equal(diff.mentionsAnalytics, true);
    assert.equal(hasAnalyticsDiff(diff, 'mobile'), true);
  });

  it('treats a catalog-only change as an analytics hit', () => {
    const diff = collectTsDiff([
      {
        filename: CATALOG_FILES.mobile,
        patch: "+NEW_EVENT = 'New Event'",
      },
    ]);
    assert.equal(diff.mentionsAnalytics, false);
    assert.equal(hasAnalyticsDiff(diff, 'mobile'), true);
  });

  it('does not treat unrelated TypeScript patches as analytics hits', () => {
    const diff = collectTsDiff([
      { filename: 'app/Home.ts', patch: '+const x = 1;\n' },
    ]);
    assert.equal(diff.mentionsAnalytics, false);
    assert.equal(hasAnalyticsDiff(diff, 'mobile'), false);
  });
});

describe('shouldPushSchema', () => {
  it('pushes on create when open, and on propose only after a schema PR exists', () => {
    assert.equal(shouldPushSchema('create', false, true, true), true);
    assert.equal(shouldPushSchema('propose', false, true, true), false);
    assert.equal(shouldPushSchema('propose', true, true, true), true);
    assert.equal(shouldPushSchema('close', true, false, true), false);
    assert.equal(shouldPushSchema('create', false, true, false), false);
  });
});

describe('decideGate', () => {
  it('skips forks, opt-out, closed PRs, and non-agreement comments', () => {
    assert.equal(
      decideGate(input({ pr: { ...PR, isFork: true } })).skipReason,
      'fork',
    );
    assert.equal(
      decideGate(input({ pr: { ...PR, hasOptOutLabel: true } })).skipReason,
      'opt-out',
    );
    assert.equal(
      decideGate(
        input({
          mode: 'create',
          eventName: 'issue_comment',
          eventAction: 'created',
          pr: { ...PR, isOpen: false },
          commentBody: AGREEMENT_PHRASE,
          commenterLogin: 'alice',
        }),
      ).skipReason,
      'client-pr-closed',
    );
    assert.equal(
      decideGate(
        input({
          mode: 'create',
          eventName: 'issue_comment',
          eventAction: 'created',
        }),
      ).skipReason,
      'agreement-mismatch',
    );
  });

  it('skips close when no schema PR exists', () => {
    const result = decideGate(
      input({
        mode: 'close',
        eventAction: 'closed',
        schemaPrExists: false,
      }),
    );
    assert.equal(result.skip, true);
    assert.equal(result.skipReason, 'no-schema-pr');
  });

  it('skips propose when there is no analytics diff, schema PR, or sticky comment', () => {
    const result = decideGate(
      input({
        pullFiles: [{ filename: 'app/Home.ts', patch: '+const x = 1;\n' }],
      }),
    );
    assert.equal(result.skipReason, 'no-analytics-diff');
  });

  it('continues propose so publish can edit a sticky comment when analytics drop off', () => {
    const result = decideGate(
      input({
        pullFiles: [{ filename: 'app/Home.ts', patch: '+const x = 1;\n' }],
        hasProposalComment: true,
      }),
    );
    assert.equal(result.skip, false);
    assert.equal(result.hasAnalyticsDiff, false);
    assert.equal(result.shouldPush, false);
  });

  it('sets tooManyFiles and does not push when the TS file list exceeds the cap', () => {
    const pullFiles = Array.from(
      { length: MAX_CHANGED_TS_FILES + 1 },
      (_, i) => ({
        filename: `app/file-${i}.ts`,
        patch: '+createEventBuilder(MetaMetricsEvents.APP_OPENED)',
      }),
    );
    const result = decideGate(input({ pullFiles, schemaPrExists: true }));
    assert.equal(result.skip, false);
    assert.equal(result.tooManyFiles, true);
    assert.equal(result.shouldPush, false);
  });

  it('pushes on create when agreement matches and YAML can be written', () => {
    const result = decideGate(
      input({
        mode: 'create',
        eventName: 'issue_comment',
        eventAction: 'created',
        commentBody: AGREEMENT_PHRASE,
        commenterLogin: 'alice',
      }),
    );
    assert.equal(result.skip, false);
    assert.equal(result.shouldPush, true);
    assert.equal(result.branch, botBranchName('mobile', 12));
  });
});
