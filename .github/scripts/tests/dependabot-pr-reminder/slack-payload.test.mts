import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pr } from './fixtures.mts';
import { buildSlackPayload } from '../../dependabot-pr-reminder/slack-payload.mts';
import type {
  Reminder,
  Topology,
} from '../../dependabot-pr-reminder/types.mts';

describe('buildSlackPayload', () => {
  const options = { fallbackTeam: 'platform', repository: 'MetaMask/example' };
  const emptyReminder = (): Reminder => ({
    byTeam: {},
    fallback: { failingCi: [], readyToMerge: [], needsOwner: [] },
  });
  const allText = (payload: { text: string; blocks: unknown[] }): string =>
    `${payload.text}\n${JSON.stringify(payload.blocks)}`;

  it('returns undefined for an empty reminder', () => {
    assert.equal(buildSlackPayload(emptyReminder(), {}, options), undefined);
  });

  it('tags a team using slackHandle.team', () => {
    const reminder = emptyReminder();
    reminder.byTeam['core-platform'] = [pr({ number: 7 })];
    const payload = buildSlackPayload(
      reminder,
      {
        'core-platform': {
          githubHandle: 'MetaMask/core-platform',
          slackHandle: { team: 'S123' },
        },
      },
      options,
    );
    assert.ok(payload);
    assert.match(allText(payload), /<!subteam\^S123>/u);
    assert.match(allText(payload), /#7/u);
    assert.match(payload.text, /<!subteam\^S123>/u);
    assert.doesNotMatch(allText(payload), /:dependabot:/u);
  });

  it('matches githubHandle regardless of case or @ prefix', () => {
    const reminder = emptyReminder();
    reminder.byTeam['core-platform'] = [pr()];
    const payload = buildSlackPayload(
      reminder,
      {
        key: {
          githubHandle: '@MetaMask/Core-Platform',
          slackHandle: { team: 'S9' },
        },
      },
      options,
    );
    assert.ok(payload);
    assert.match(allText(payload), /<!subteam\^S9>/u);
  });

  it('falls back to the plain team name when topology has no match', () => {
    const reminder = emptyReminder();
    reminder.byTeam['core-platform'] = [pr()];
    const payload = buildSlackPayload(reminder, {}, options);
    assert.ok(payload);
    assert.match(allText(payload), /core-platform/u);
    assert.doesNotMatch(allText(payload), /subteam\^/u);
  });

  it('escapes &, <, > in PR titles', () => {
    const reminder = emptyReminder();
    reminder.byTeam.a = [pr({ title: 'Bump <a> & b > c' })];
    const payload = buildSlackPayload(reminder, {}, options);
    assert.ok(payload);
    assert.match(allText(payload), /Bump &lt;a&gt; &amp; b &gt; c/u);
  });

  it('renders fallback sections under the fallback team', () => {
    const reminder = emptyReminder();
    reminder.fallback.failingCi = [pr({ number: 1 })];
    reminder.fallback.readyToMerge = [pr({ number: 2 })];
    reminder.fallback.needsOwner = [pr({ number: 3 })];
    const payload = buildSlackPayload(
      reminder,
      {
        platform: {
          githubHandle: 'MetaMask/platform',
          slackHandle: { team: 'SF' },
        },
      },
      options,
    );
    assert.ok(payload);
    const text = allText(payload);
    assert.match(text, /<!subteam\^SF>/u);
    assert.match(text, /[Ff]ailing CI/u);
    assert.match(text, /[Rr]eady to merge/u);
    assert.match(text, /[Nn]eeds owner/u);
    assert.match(text, /#1/u);
    assert.match(text, /#2/u);
    assert.match(text, /#3/u);
  });
});

describe('buildSlackPayload chunking', () => {
  it('splits a long team list into sections under the Slack limit', () => {
    const pullRequests = Array.from({ length: 60 }, (_, index) =>
      pr({
        number: index + 1,
        title: `Bump some-long-package-name-${index} from 1.0.0 to 1.0.1`,
        url: `https://github.com/MetaMask/example/pull/${index + 1}`,
      }),
    );
    const reminder: Reminder = {
      byTeam: { wallet: pullRequests },
      fallback: { failingCi: [], readyToMerge: [], needsOwner: [] },
    };
    const payload = buildSlackPayload(
      reminder,
      {},
      { fallbackTeam: 'f', repository: 'MetaMask/example' },
    );
    assert.ok(payload);
    const texts = payload.blocks.map((block) => block.text.text);
    assert.ok(texts.length > 3);
    for (const text of texts) {
      assert.ok(text.length <= 3000, `section has ${text.length} characters`);
    }
    const joined = texts.join('\n');
    for (const { number } of pullRequests) {
      assert.ok(joined.includes(`#${number} `), `PR #${number} is missing`);
    }
  });
});

describe('buildSlackPayload limits and lookup', () => {
  const options = { fallbackTeam: 'f', repository: 'MetaMask/example' };

  it('caps blocks at 50 and appends an overflow line', () => {
    const byTeam: Reminder['byTeam'] = {};
    for (let index = 0; index < 80; index++) {
      byTeam[`team-${index}`] = [pr({ number: index + 1 })];
    }
    const payload = buildSlackPayload(
      { byTeam, fallback: { failingCi: [], readyToMerge: [], needsOwner: [] } },
      {},
      options,
    );
    assert.ok(payload);
    assert.ok(payload.blocks.length <= 50);
    const last = payload.blocks[payload.blocks.length - 1];
    assert.match(last?.text.text ?? '', /…and \d+ more/u);
  });

  it('does not throw on null topology entries', () => {
    const payload = buildSlackPayload(
      {
        byTeam: { a: [pr()] },
        fallback: { failingCi: [], readyToMerge: [], needsOwner: [] },
      },
      {
        bad: null,
        good: { githubHandle: 'MetaMask/a', slackHandle: { team: 'S1' } },
      } as unknown as Topology,
      options,
    );
    assert.match(payload?.text ?? '', /<!subteam\^S1>/u);
  });
});
