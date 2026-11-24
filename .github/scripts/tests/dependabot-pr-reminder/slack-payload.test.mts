import { assert, describe, expect, it } from 'vitest';

import { buildSlackPayload } from '../../dependabot-pr-reminder/slack-payload.mts';
import type { Reminder } from '../../dependabot-pr-reminder/types.mts';
import { pr, sectionText } from './fixtures.mts';

describe('buildSlackPayload', () => {
  const options = { fallbackTeam: 'platform', repository: 'MetaMask/example' };
  const emptyReminder = (): Reminder => ({
    byTeam: {},
    fallback: { sharedByManyTeams: [], noTeam: [] },
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
    reminder.fallback.noTeam = [pr({ number: 3 })];
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
      fallback: { sharedByManyTeams: [], noTeam: [] },
    };
    const payload = buildSlackPayload(
      reminder,
      {},
      { fallbackTeam: 'f', repository: 'MetaMask/example' },
    );
    assert.ok(payload);
    const texts = payload.blocks.map(sectionText);
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
      {
        byTeam,
        fallback: { sharedByManyTeams: [], noTeam: [] },
      },
      {},
      options,
    );
    assert.ok(payload);
    expect(payload.blocks.length).toBeLessThanOrEqual(50);
    expect(sectionText(payload.blocks.at(-1))).toMatch(/…and \d+ more/u);
  });

  it('does not throw on null topology entries', () => {
    const payload = buildSlackPayload(
      {
        byTeam: { a: [pr()] },
        fallback: { sharedByManyTeams: [], noTeam: [] },
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
  const fallback = { sharedByManyTeams: [], noTeam: [] };

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
    expect(sectionText(payload.blocks[1])).toMatch(/x…>$/u);
    expect(sectionText(payload.blocks[1])).not.toContain('&amp;');
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

describe('buildSlackPayload grouping', () => {
  const options = { fallbackTeam: 'f', repository: 'MetaMask/example' };
  const fallback = { sharedByManyTeams: [], noTeam: [] };
  const topology = {
    a: { githubHandle: 'MetaMask/a', slackHandle: { team: '@a-team' } },
    b: { githubHandle: 'MetaMask/b', slackHandle: { team: '@b-team' } },
  };

  it('lists a shared set of PRs once under all of its teams', () => {
    const shared = [pr({ number: 1 }), pr({ number: 2 })];
    const payload = buildSlackPayload(
      {
        byTeam: { a: shared, b: [pr({ number: 2 }), pr({ number: 1 })] },
        fallback,
      },
      topology,
      options,
    );
    assert.ok(payload);
    expect(payload.blocks).toHaveLength(2);
    const [, sharedBlock] = payload.blocks;
    expect(sectionText(sharedBlock).split('\n')[0]).toBe('@a-team @b-team');
    expect(sectionText(sharedBlock).match(/#1 /gu)).toHaveLength(1);
    expect(payload.text).toContain('@a-team @b-team');
  });

  it('lists each PR once, under all of its teams', () => {
    const payload = buildSlackPayload(
      {
        byTeam: {
          a: [pr({ number: 1 }), pr({ number: 2 })],
          b: [pr({ number: 2 })],
          c: [pr({ number: 2 })],
        },
        fallback,
      },
      topology,
      options,
    );
    assert.ok(payload);
    expect(payload.blocks).toHaveLength(3);
    expect(sectionText(payload.blocks[1]).split('\n')[0]).toBe('@a-team');
    expect(sectionText(payload.blocks[1])).toMatch(/#1 /u);
    expect(sectionText(payload.blocks[2]).split('\n')[0]).toBe(
      '@a-team @b-team c',
    );
    expect(sectionText(payload.blocks[2])).toMatch(/#2 /u);
    expect(JSON.stringify(payload.blocks).match(/#2 /gu)).toHaveLength(1);
  });

  it('puts PRs with the same teams together', () => {
    const payload = buildSlackPayload(
      {
        byTeam: {
          a: [pr({ number: 1 }), pr({ number: 2 })],
          b: [pr({ number: 2 }), pr({ number: 1 })],
        },
        fallback,
      },
      topology,
      options,
    );
    assert.ok(payload);
    expect(payload.blocks).toHaveLength(2);
    expect(sectionText(payload.blocks[1]).split('\n')).toHaveLength(3);
  });

  it('shows a team without a handle as plain text next to tagged teams', () => {
    const payload = buildSlackPayload(
      { byTeam: { a: [pr()], plain: [pr()] }, fallback },
      topology,
      options,
    );
    assert.ok(payload);
    expect(sectionText(payload.blocks[1]).split('\n')[0]).toBe('@a-team plain');
    expect(payload.text).toContain('@a-team');
    expect(payload.text).not.toContain('plain');
  });
});

describe('buildSlackPayload note', () => {
  const fallback = { sharedByManyTeams: [], noTeam: [] };

  it('adds the note as a section right under the headline', () => {
    const payload = buildSlackPayload(
      { byTeam: { a: [pr()] }, fallback },
      {},
      { fallbackTeam: 'f', repository: 'MetaMask/example', note: 'Own it.' },
    );
    assert.ok(payload);
    expect(payload.blocks[1]).toStrictEqual({
      type: 'section',
      text: { type: 'mrkdwn', text: 'Own it.' },
    });
  });

  it('leaves the note out when there is none', () => {
    const payload = buildSlackPayload(
      { byTeam: { a: [pr()] }, fallback },
      {},
      { fallbackTeam: 'f', repository: 'MetaMask/example' },
    );
    assert.ok(payload);
    expect(payload.blocks.map(({ type }) => type)).toStrictEqual([
      'section',
      'section',
    ]);
  });

  it('keeps the note when the block cap is hit', () => {
    const byTeam: Reminder['byTeam'] = {};
    for (let index = 0; index < 80; index++) {
      byTeam[`team-${index}`] = [pr({ number: index + 1 })];
    }
    const payload = buildSlackPayload(
      { byTeam, fallback },
      {},
      {
        fallbackTeam: 'f',
        repository: 'MetaMask/example',
        note: 'Own it.',
      },
    );
    assert.ok(payload);
    expect(payload.blocks).toHaveLength(50);
    expect(sectionText(payload.blocks[1])).toBe('Own it.');
    expect(sectionText(payload.blocks.at(-1))).toMatch(/…and \d+ more/u);
  });

  it('cuts a very long note to fit Slack', () => {
    const payload = buildSlackPayload(
      { byTeam: { a: [pr()] }, fallback },
      {},
      {
        fallbackTeam: 'f',
        repository: 'MetaMask/example',
        note: 'x'.repeat(5000),
      },
    );
    assert.ok(payload);
    const serialized = JSON.stringify(payload.blocks[1]);
    expect(serialized).toContain('…');
    expect(serialized.length).toBeLessThan(2900);
  });
});

describe('buildSlackPayload shared by many teams', () => {
  const fallback = {
    sharedByManyTeams: [
      pr({ number: 9, requestedTeams: ['a', 'b', 'c', 'd'] }),
    ],
    noTeam: [],
  };
  const topology = {
    platform: {
      githubHandle: 'MetaMask/platform',
      slackHandle: { team: '@platform-team' },
    },
  };

  it('lists the PR under the fallback team with how many teams it has', () => {
    const payload = buildSlackPayload({ byTeam: {}, fallback }, topology, {
      fallbackTeam: 'platform',
      repository: 'MetaMask/example',
    });
    assert.ok(payload);
    const text = sectionText(payload.blocks[1]);
    expect(text.split('\n')[0]).toBe('@platform-team *Shared by many teams*');
    expect(text).toMatch(/#9 .*\(4 teams\)$/u);
    expect(payload.text).toContain('@platform-team');
  });

  it('puts the shared section before the PRs with no team', () => {
    const payload = buildSlackPayload(
      {
        byTeam: {},
        fallback: {
          ...fallback,
          noTeam: [pr({ number: 3 })],
        },
      },
      topology,
      { fallbackTeam: 'platform', repository: 'MetaMask/example' },
    );
    assert.ok(payload);
    const headers = payload.blocks
      .slice(1)
      .map((block) => sectionText(block).split('\n')[0]);
    expect(headers).toStrictEqual([
      '@platform-team *Shared by many teams*',
      '@platform-team',
    ]);
  });
});
