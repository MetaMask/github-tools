import { assert, describe, expect, it } from 'vitest';

import { buildSlackPayload } from '../../dependabot-pr-reminder/slack-payload.mts';
import type { Reminder } from '../../dependabot-pr-reminder/types.mts';
import { pr } from './fixtures.mts';

describe('buildSlackPayload', () => {
  const options = { fallbackTeam: 'platform', repository: 'MetaMask/example' };
  const emptyReminder = (): Reminder => ({
    byTeam: {},
    fallback: { failingCi: [], readyToMerge: [], needsOwner: [] },
  });
  const allText = (payload: { text: string; blocks: unknown[] }): string =>
    `${payload.text}\n${JSON.stringify(payload.blocks)}`;

  it('returns undefined for an empty reminder', () => {
    expect(buildSlackPayload(emptyReminder(), {}, options)).toBeUndefined();
  });

  it('tags a team using slackHandle.team', () => {
    const reminder = emptyReminder();
    reminder.byTeam['core-platform'] = [pr({ number: 7 })];
    const payload = buildSlackPayload(
      reminder,
      {
        'core-platform': {
          githubHandle: 'MetaMask/core-platform',
          slackHandle: { team: '@core-platform-team' },
        },
      },
      options,
    );
    assert.ok(payload);
    expect(allText(payload)).toMatch(/@core-platform-team/u);
    expect(allText(payload)).toMatch(/#7/u);
    expect(payload.text).toMatch(/@core-platform-team/u);
    expect(allText(payload)).not.toMatch(/:dependabot:/u);
  });

  it('matches githubHandle regardless of case or @ prefix', () => {
    const reminder = emptyReminder();
    reminder.byTeam['core-platform'] = [pr()];
    const payload = buildSlackPayload(
      reminder,
      {
        key: {
          githubHandle: '@MetaMask/Core-Platform',
          slackHandle: { team: '@nine-team' },
        },
      },
      options,
    );
    assert.ok(payload);
    expect(allText(payload)).toMatch(/@nine-team/u);
  });

  it('falls back to the plain team name when topology has no match', () => {
    const reminder = emptyReminder();
    reminder.byTeam['core-platform'] = [pr()];
    const payload = buildSlackPayload(reminder, {}, options);
    assert.ok(payload);
    expect(allText(payload)).toMatch(/core-platform/u);
    expect(allText(payload)).not.toMatch(/@core-platform-team/u);
  });

  it('escapes &, <, > in PR titles', () => {
    const reminder = emptyReminder();
    reminder.byTeam.a = [pr({ title: 'Bump <a> & b > c' })];
    const payload = buildSlackPayload(reminder, {}, options);
    assert.ok(payload);
    expect(allText(payload)).toMatch(/Bump &lt;a&gt; &amp; b &gt; c/u);
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
          slackHandle: { team: '@platform-team' },
        },
      },
      options,
    );
    assert.ok(payload);
    const text = allText(payload);
    expect(text).toMatch(/@platform-team/u);
    expect(text).toMatch(/[Ff]ailing CI/u);
    expect(text).toMatch(/[Rr]eady to merge/u);
    expect(text).toMatch(/[Nn]eeds owner/u);
    expect(text).toMatch(/#1/u);
    expect(text).toMatch(/#2/u);
    expect(text).toMatch(/#3/u);
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
    expect(texts.length).toBeGreaterThan(3);
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
    expect(payload.blocks.length).toBeLessThanOrEqual(50);
    expect(payload.blocks.at(-1)?.text.text).toMatch(/…and \d+ more/u);
  });

  it('does not throw on null topology entries', () => {
    const payload = buildSlackPayload(
      {
        byTeam: { a: [pr()] },
        fallback: { failingCi: [], readyToMerge: [], needsOwner: [] },
      },
      {
        bad: null,
        good: { githubHandle: 'MetaMask/a', slackHandle: { team: '@a-team' } },
      },
      options,
    );
    expect(payload?.text).toMatch(/@a-team/u);
  });
});

describe('buildSlackPayload mentions and titles', () => {
  const options = { fallbackTeam: 'f', repository: 'MetaMask/example' };
  const fallback = { failingCi: [], readyToMerge: [], needsOwner: [] };

  it('does not turn @ text in titles into mentions', () => {
    const payload = buildSlackPayload(
      { byTeam: { a: [pr({ title: 'Bump @here/x' })] }, fallback },
      {},
      options,
    );
    assert.ok(payload);
    expect(payload).not.toHaveProperty('link_names');
  });

  it('shortens long titles before wrapping them in a link', () => {
    const payload = buildSlackPayload(
      { byTeam: { a: [pr({ title: `${'x'.repeat(500)} & more` })] }, fallback },
      {},
      options,
    );
    assert.ok(payload);
    expect(payload.blocks[1]?.text.text).toMatch(/x…>$/u);
    expect(payload.blocks[1]?.text.text).not.toContain('&amp;');
  });

  it('only pings teams whose section is shown', () => {
    const byTeam: Reminder['byTeam'] = {};
    const topology: Record<
      string,
      { githubHandle: string; slackHandle: { team: string } }
    > = {};
    for (let index = 0; index < 80; index++) {
      byTeam[`team-${index}`] = [pr({ number: index + 1 })];
      topology[`t${index}`] = {
        githubHandle: `MetaMask/team-${index}`,
        slackHandle: { team: `@g${index}` },
      };
    }
    const payload = buildSlackPayload({ byTeam, fallback }, topology, options);
    assert.ok(payload);
    expect(payload.blocks).toHaveLength(50);
    expect(payload.text).toContain('@g0');
    expect(payload.text).not.toContain('@g79');
  });
});
