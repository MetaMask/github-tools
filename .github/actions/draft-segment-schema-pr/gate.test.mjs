import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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
    expect(eventSkipReason('propose', 'issue_comment', 'created')).toBe(
      'wrong-event',
    );
    expect(eventSkipReason('propose', 'pull_request', 'closed')).toBe(
      'wrong-event',
    );
    expect(eventSkipReason('close', 'pull_request', 'synchronize')).toBe(
      'wrong-event',
    );
    expect(eventSkipReason('create', 'issue_comment', 'created')).toBe('');
    expect(eventSkipReason('propose', 'pull_request', 'synchronize')).toBe('');
    expect(eventSkipReason('close', 'pull_request', 'closed')).toBe('');
  });
});

describe('isAgreementComment', () => {
  it('treats trailing whitespace on the agreement sentence as a match', () => {
    expect(
      isAgreementComment(`${AGREEMENT_PHRASE}  \nThanks`, 'alice', 'alice'),
    ).toBe(true);
    expect(isAgreementComment(AGREEMENT_PHRASE, 'bob', 'alice')).toBe(false);
    expect(isAgreementComment('please open it', 'alice', 'alice')).toBe(false);
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
    expect(diff.files).toStrictEqual(['app/Home.ts']);
    expect(diff.mentionsAnalytics).toBe(true);
    expect(hasAnalyticsDiff(diff, 'mobile')).toBe(true);
  });

  it('treats a catalog-only change as an analytics hit', () => {
    const diff = collectTsDiff([
      {
        filename: CATALOG_FILES.mobile,
        patch: "+NEW_EVENT = 'New Event'",
      },
    ]);
    expect(diff.mentionsAnalytics).toBe(false);
    expect(hasAnalyticsDiff(diff, 'mobile')).toBe(true);
  });

  it('does not treat unrelated TypeScript patches as analytics hits', () => {
    const diff = collectTsDiff([
      { filename: 'app/Home.ts', patch: '+const x = 1;\n' },
    ]);
    expect(diff.mentionsAnalytics).toBe(false);
    expect(hasAnalyticsDiff(diff, 'mobile')).toBe(false);
  });

  it('treats addSensitiveProperties as an analytics hit', () => {
    const diff = collectTsDiff([
      {
        filename: 'app/Home.ts',
        patch: '+.addSensitiveProperties({ secret: true })',
      },
    ]);
    expect(diff.mentionsAnalytics).toBe(true);
  });

  it('counts a renamed TypeScript file once', () => {
    const diff = collectTsDiff([
      {
        filename: 'app/next.ts',
        previous_filename: 'app/prev.ts',
        patch: '+const x = 1;\n',
      },
    ]);
    expect(diff.files).toStrictEqual(['app/next.ts', 'app/prev.ts']);
    expect(diff.recordCount).toBe(1);
  });
});

describe('shouldPushSchema', () => {
  it('pushes on create when open, and on propose only after a schema PR exists', () => {
    expect(shouldPushSchema('create', false, true, true)).toBe(true);
    expect(shouldPushSchema('propose', false, true, true)).toBe(false);
    expect(shouldPushSchema('propose', true, true, true)).toBe(true);
    expect(shouldPushSchema('close', true, false, true)).toBe(false);
    expect(shouldPushSchema('create', false, true, false)).toBe(false);
  });
});

describe('decideGate', () => {
  it('skips forks, opt-out, closed PRs, and non-agreement comments', () => {
    expect(decideGate(input({ pr: { ...PR, isFork: true } })).skipReason).toBe(
      'fork',
    );
    expect(
      decideGate(input({ pr: { ...PR, hasOptOutLabel: true } })).skipReason,
    ).toBe('opt-out');
    expect(
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
    ).toBe('client-pr-closed');
    expect(
      decideGate(
        input({
          mode: 'create',
          eventName: 'issue_comment',
          eventAction: 'created',
        }),
      ).skipReason,
    ).toBe('agreement-mismatch');
  });

  it('skips close when no schema PR exists', () => {
    const result = decideGate(
      input({
        mode: 'close',
        eventAction: 'closed',
        schemaPrExists: false,
      }),
    );
    expect(result.skip).toBe(true);
    expect(result.skipReason).toBe('no-schema-pr');
  });

  it('skips propose when there is no analytics diff, schema PR, or sticky comment', () => {
    const result = decideGate(
      input({
        pullFiles: [{ filename: 'app/Home.ts', patch: '+const x = 1;\n' }],
      }),
    );
    expect(result.skipReason).toBe('no-analytics-diff');
  });

  it('continues propose so publish can edit a sticky comment when analytics drop off', () => {
    const result = decideGate(
      input({
        pullFiles: [{ filename: 'app/Home.ts', patch: '+const x = 1;\n' }],
        hasProposalComment: true,
      }),
    );
    expect(result.skip).toBe(false);
    expect(result.hasAnalyticsDiff).toBe(false);
    expect(result.shouldPush).toBe(false);
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
    expect(result.skip).toBe(false);
    expect(result.tooManyFiles).toBe(true);
    expect(result.shouldPush).toBe(false);
  });

  it('does not treat 76 renamed TypeScript files as over the cap', () => {
    const pullFiles = Array.from({ length: 76 }, (_, i) => ({
      filename: `app/next-${i}.ts`,
      previous_filename: `app/prev-${i}.ts`,
      patch: '+createEventBuilder(MetaMetricsEvents.APP_OPENED)',
    }));
    const result = decideGate(input({ pullFiles }));
    expect(result.tooManyFiles).toBe(false);
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
    expect(result.skip).toBe(false);
    expect(result.shouldPush).toBe(true);
    expect(result.branch).toBe(botBranchName('mobile', 12));
  });
});

describe('schema pull list client', () => {
  it('builds the schema client from the schema token', () => {
    const action = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'action.yml'),
      'utf8',
    );
    expect(action).toMatch(/getOctokit\(process\.env\.SEGMENT_SCHEMA_TOKEN\)/u);
    expect(action).not.toMatch(/const \{\s*getOctokit\s*\}/u);
    expect(action).not.toMatch(/headers:\s*\{\s*authorization:/u);
  });
});
