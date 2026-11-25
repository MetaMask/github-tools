import { assert, describe, expect, it } from 'vitest';

import { buildSlackPayload } from '../../dependabot-pr-reminder/slack-payload.mts';
import type {
  PullRequest,
  Reminder,
} from '../../dependabot-pr-reminder/types.mts';
import { pr, sectionText } from './fixtures.mts';

const options = { fallbackTeam: 'platform', repository: 'MetaMask/example' };

const topology = {
  a: { githubHandle: 'MetaMask/a', slackHandle: { team: '@a-team' } },
  b: { githubHandle: 'MetaMask/b', slackHandle: { team: '@b-team' } },
  platform: {
    githubHandle: 'MetaMask/platform',
    slackHandle: { team: '@platform-team' },
  },
};

/**
 * Builds a reminder for tests.
 *
 * @param parts - The parts of the reminder.
 * @param parts.byTeam - Pull requests by team.
 * @param parts.shared - Pull requests shared by many teams.
 * @param parts.noTeam - Pull requests with no team.
 * @returns The reminder.
 */
function reminder(
  parts: {
    byTeam?: Record<string, PullRequest[]>;
    shared?: PullRequest[];
    noTeam?: PullRequest[];
  } = {},
): Reminder {
  return {
    byTeam: parts.byTeam ?? {},
    fallback: {
      sharedByManyTeams: parts.shared ?? [],
      noTeam: parts.noTeam ?? [],
    },
  };
}

describe('buildSlackPayload', () => {
  it('returns undefined when there are no pull requests', () => {
    expect(buildSlackPayload(reminder(), {}, options)).toBeUndefined();
  });

  it('starts with a header, the counts and a divider, and ends with a legend', () => {
    const payload = buildSlackPayload(
      reminder({ byTeam: { a: [pr({ ciState: 'passing' })] } }),
      topology,
      options,
    );
    assert.ok(payload);
    const types = payload.blocks.map(({ type }) => type);
    expect(types.slice(0, 3)).toStrictEqual(['header', 'context', 'divider']);
    expect(types.slice(-2)).toStrictEqual(['divider', 'context']);
    expect(JSON.stringify(payload.blocks[0])).toContain(
      ':dependabot: Open Dependabot pull requests',
    );
    expect(JSON.stringify(payload.blocks.at(-1))).toContain(
      ':white_check_mark: CI passes · :x: CI fails',
    );
  });

  it('shows the repository link, how many are open, and only the states present', () => {
    const payload = buildSlackPayload(
      reminder({
        byTeam: {
          a: [
            pr({ number: 1, ciState: 'passing' }),
            pr({ number: 2, ciState: 'failing' }),
            pr({ number: 3, ciState: 'failing' }),
          ],
        },
      }),
      topology,
      options,
    );
    assert.ok(payload);
    expect(JSON.stringify(payload.blocks[1])).toContain(
      '<https://github.com/MetaMask/example|MetaMask/example> · *3* open · :white_check_mark: 1 passing · :x: 2 failing',
    );
    expect(JSON.stringify(payload.blocks[1])).not.toContain('running');
  });

  it('puts the note between the counts and the first divider', () => {
    const payload = buildSlackPayload(
      reminder({ byTeam: { a: [pr()] } }),
      topology,
      { ...options, note: 'Own it.' },
    );
    assert.ok(payload);
    expect(payload.blocks.map(({ type }) => type).slice(0, 4)).toStrictEqual([
      'header',
      'context',
      'section',
      'divider',
    ]);
    expect(sectionText(payload.blocks[2])).toBe('Own it.');
  });

  it('leaves the note out when there is none', () => {
    const payload = buildSlackPayload(
      reminder({ byTeam: { a: [pr()] } }),
      topology,
      options,
    );
    assert.ok(payload);
    expect(payload.blocks.map(({ type }) => type)).not.toContain('Own it.');
    expect(payload.blocks[2]?.type).toBe('divider');
  });

  it('groups by CI state in order, with dividers between the groups', () => {
    const payload = buildSlackPayload(
      reminder({
        byTeam: {
          a: [
            pr({ number: 1, ciState: 'passing' }),
            pr({ number: 2, ciState: 'failing' }),
            pr({ number: 3, ciState: 'pending' }),
          ],
        },
        shared: [pr({ number: 4, ciState: 'failing', requestedTeams: ['x'] })],
      }),
      topology,
      options,
    );
    assert.ok(payload);
    const headings = payload.blocks
      .filter(({ type }) => type === 'section')
      .map((block) => sectionText(block).split('\n')[0]);
    expect(headings).toStrictEqual([
      '*:x: Needs a fix*',
      '*:hourglass_flowing_sand: In progress*',
      '*:busts_in_silhouette: Shared by many teams*',
      '*:white_check_mark: CI passing*',
    ]);
  });

  it('shows the package and versions and tags the teams under each PR', () => {
    const payload = buildSlackPayload(
      reminder({
        byTeam: {
          a: [pr({ number: 7, ciState: 'failing' })],
          b: [pr({ number: 7, ciState: 'failing' })],
          plain: [pr({ number: 7, ciState: 'failing' })],
        },
      }),
      topology,
      options,
    );
    assert.ok(payload);
    const text = sectionText(payload.blocks[3]);
    expect(text).toBe(
      '*:x: Needs a fix*\n<https://github.com/MetaMask/example/pull/1|#7> `foo` 1.0.0 → 1.0.1\n@a-team @b-team plain',
    );
  });

  it('lists each PR once, even when many teams share it', () => {
    const payload = buildSlackPayload(
      reminder({
        byTeam: {
          a: [pr({ number: 1 }), pr({ number: 2 })],
          b: [pr({ number: 2 })],
        },
      }),
      topology,
      options,
    );
    assert.ok(payload);
    const all = JSON.stringify(payload.blocks);
    expect(all.match(/\|#1>/gu)).toHaveLength(1);
    expect(all.match(/\|#2>/gu)).toHaveLength(1);
  });

  it('shows a PR with no team under the fallback team', () => {
    const payload = buildSlackPayload(
      reminder({ noTeam: [pr({ number: 5, ciState: 'passing' })] }),
      topology,
      options,
    );
    assert.ok(payload);
    expect(sectionText(payload.blocks[3])).toBe(
      '*:white_check_mark: CI passing*\n<https://github.com/MetaMask/example/pull/1|#5> `foo` 1.0.0 → 1.0.1\n@platform-team',
    );
  });

  it('shows shared PRs with an icon and team count, coordinated by the fallback team', () => {
    const payload = buildSlackPayload(
      reminder({
        shared: [
          pr({
            number: 9,
            ciState: 'failing',
            requestedTeams: ['a', 'b', 'c', 'd', 'e', 'f'],
          }),
        ],
      }),
      topology,
      options,
    );
    assert.ok(payload);
    const text = sectionText(payload.blocks[3]);
    expect(text.split('\n')[0]).toBe(
      '*:busts_in_silhouette: Shared by many teams*',
    );
    expect(text.split('\n')[1]).toBe('Coordinated by @platform-team');
    expect(text).toMatch(/:x: <[^>]*\|#9> `foo` 1\.0\.0 → 1\.0\.1 · 6 teams$/u);
  });

  it('shows an icon per PR in the in progress group', () => {
    const payload = buildSlackPayload(
      reminder({
        byTeam: {
          a: [
            pr({ number: 1, ciState: 'pending' }),
            pr({ number: 2, ciState: 'unknown' }),
          ],
        },
      }),
      topology,
      options,
    );
    assert.ok(payload);
    const text = sectionText(payload.blocks[3]);
    expect(text).toMatch(/:hourglass_flowing_sand: <[^>]*\|#1>/u);
    expect(text).toMatch(/:white_circle: <[^>]*\|#2>/u);
  });

  it('puts the handles of tagged teams in the top level text', () => {
    const payload = buildSlackPayload(
      reminder({
        byTeam: { a: [pr()], b: [pr()], plain: [pr()] },
      }),
      topology,
      options,
    );
    assert.ok(payload);
    expect(payload.text).toContain('@a-team @b-team');
    expect(payload.text).not.toContain('plain');
  });

  it('escapes the title of a PR it cannot read and cuts it short', () => {
    const payload = buildSlackPayload(
      reminder({
        byTeam: { a: [pr({ title: `Odd <title> & ${'x'.repeat(500)}` })] },
      }),
      topology,
      options,
    );
    assert.ok(payload);
    const text = sectionText(payload.blocks[3]);
    expect(text).toContain('Odd &lt;title&gt; &amp; ');
    expect(text).toContain('…');
    expect(text.length).toBeLessThan(500);
  });

  it('does not turn @ text into mentions with link_names', () => {
    const payload = buildSlackPayload(
      reminder({ byTeam: { a: [pr({ title: 'Bump @here/x' })] } }),
      topology,
      options,
    );
    assert.ok(payload);
    expect(payload).not.toHaveProperty('link_names');
  });

  it('splits a long group into blocks under the Slack limit, repeating the heading', () => {
    const pullRequests = Array.from({ length: 60 }, (_, index) =>
      pr({
        number: index + 1,
        title: `chore(deps): bump some-long-package-name-${index} from 1.0.0 to 1.0.1`,
        ciState: 'failing',
      }),
    );
    const payload = buildSlackPayload(
      reminder({ byTeam: { a: pullRequests } }),
      topology,
      options,
    );
    assert.ok(payload);
    const sections = payload.blocks.filter(({ type }) => type === 'section');
    expect(sections.length).toBeGreaterThan(1);
    for (const block of sections) {
      expect(sectionText(block).length).toBeLessThanOrEqual(3000);
      expect(sectionText(block).startsWith('*:x: Needs a fix*\n')).toBe(true);
    }
    const all = JSON.stringify(payload.blocks);
    for (const { number } of pullRequests) {
      expect(all).toContain(`|#${number}>`);
    }
  });
});

describe('buildSlackPayload block limit', () => {
  /**
   * Builds many teams that each have their own PR, in a handle each.
   *
   * @returns The reminder and the topology.
   */
  function manyTeams(): {
    reminder: Reminder;
    topology: Record<
      string,
      { githubHandle: string; slackHandle: { team: string } }
    >;
  } {
    const byTeam: Reminder['byTeam'] = {};
    const manyTopology: Record<
      string,
      { githubHandle: string; slackHandle: { team: string } }
    > = {};
    for (let index = 0; index < 800; index++) {
      byTeam[`team-${index}`] = [
        pr({
          number: index + 1,
          title: `chore(deps): bump ${'p'.repeat(150)}${index} from 1.0.0 to 1.0.1`,
          ciState: 'failing',
        }),
      ];
      manyTopology[`t${index}`] = {
        githubHandle: `MetaMask/team-${index}`,
        slackHandle: { team: `@g${index}` },
      };
    }
    return { reminder: reminder({ byTeam }), topology: manyTopology };
  }

  it('stays under 50 blocks, keeps the legend, and says how many were left out', () => {
    const many = manyTeams();
    const payload = buildSlackPayload(many.reminder, many.topology, options);
    assert.ok(payload);
    expect(payload.blocks.length).toBeLessThanOrEqual(50);
    expect(payload.blocks.at(-1)?.type).toBe('context');
    expect(JSON.stringify(payload.blocks)).toMatch(
      /…and \d+ more pull request\(s\) not shown/u,
    );
  });

  it('only pings teams whose PRs are shown', () => {
    const many = manyTeams();
    const payload = buildSlackPayload(many.reminder, many.topology, options);
    assert.ok(payload);
    expect(payload.text).toContain('@g0');
    expect(payload.text).not.toContain('@g799');
  });
});
