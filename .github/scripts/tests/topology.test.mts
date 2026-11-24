import { describe, expect, it, vi } from 'vitest';

import {
  buildTopologyPath,
  fetchTopology,
  findTeamBySlug,
  findTeamsByMember,
  getSlackHandle,
  normalizeTeamSlug,
} from '../shared/topology.mts';
import type { Topology } from '../shared/topology.mts';

const topology: Topology = {
  bad: null,
  core: {
    githubHandle: 'MetaMask/core-platform',
    githubLabel: { name: 'team-core-platform' },
    slackHandle: { team: '@core-platform-team' },
    members: ['alice'],
    pm: 'pat',
    em: 'eve',
    tl: 'tom',
  },
  ui: { githubHandle: 'MetaMask/ui' },
};

describe('normalizeTeamSlug', () => {
  it('lowercases and strips the @ and metamask/ prefixes', () => {
    expect(normalizeTeamSlug('@MetaMask/Core-Platform')).toBe('core-platform');
  });
});

describe('buildTopologyPath', () => {
  it('encodes the ref', () => {
    expect(buildTopologyPath('feat/a b#c')).toBe(
      'repos/MetaMask/MetaMask-planning/contents/topology.json?ref=feat%2Fa%20b%23c',
    );
  });
});

describe('fetchTopology', () => {
  const sleep = async (): Promise<void> => undefined;

  it('reads the raw file at the ref with one call', async () => {
    const run = vi
      .fn<() => Promise<string>>()
      .mockResolvedValue(JSON.stringify(topology));
    const result = await fetchTopology({
      ref: 'main',
      gh: { run, sleep, token: 't', environment: {} },
    });
    expect(result).toStrictEqual(topology);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(
      ['-H', 'Accept: application/vnd.github.raw', buildTopologyPath('main')],
      { GH_TOKEN: 't' },
    );
  });

  it('rejects a response that is not a JSON object', async () => {
    const run = vi.fn<() => Promise<string>>().mockResolvedValue('[]');
    await expect(
      fetchTopology({ gh: { environment: {}, run, sleep } }),
    ).rejects.toThrow('not a JSON object');
  });
});

describe('findTeamBySlug', () => {
  it('matches regardless of case or prefix and skips null entries', () => {
    expect(findTeamBySlug(topology, '@MetaMask/Core-Platform')).toBe(
      topology.core,
    );
  });

  it('returns undefined when nothing matches', () => {
    expect(findTeamBySlug(topology, 'nope')).toBeUndefined();
  });
});

describe('getSlackHandle', () => {
  it('returns the Slack user group handle', () => {
    expect(getSlackHandle(topology, 'core-platform')).toBe(
      '@core-platform-team',
    );
  });

  it('adds a missing @', () => {
    expect(
      getSlackHandle(
        { a: { githubHandle: 'MetaMask/a', slackHandle: { team: 'a-team' } } },
        'a',
      ),
    ).toBe('@a-team');
  });

  it('returns undefined for a missing or empty handle or an unknown team', () => {
    expect(getSlackHandle(topology, 'ui')).toBeUndefined();
    expect(
      getSlackHandle(
        { a: { githubHandle: 'MetaMask/a', slackHandle: { team: '' } } },
        'a',
      ),
    ).toBeUndefined();
    expect(getSlackHandle(topology, 'nope')).toBeUndefined();
  });

  it('rejects values that are not a plain handle', () => {
    expect(
      getSlackHandle(
        {
          a: {
            githubHandle: 'MetaMask/a',
            slackHandle: { team: '<!channel>' },
          },
        },
        'a',
      ),
    ).toBeUndefined();
  });
});

describe('findTeamsByMember', () => {
  it.each(['alice', 'pat', 'eve', 'tom'])('finds %s', (user) => {
    expect(findTeamsByMember(topology, user)).toStrictEqual([topology.core]);
  });

  it('returns nothing for an unknown user', () => {
    expect(findTeamsByMember(topology, 'zed')).toStrictEqual([]);
  });
});
