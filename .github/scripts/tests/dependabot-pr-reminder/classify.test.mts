import { describe, expect, it } from 'vitest';

import { classifyPullRequests } from '../../dependabot-pr-reminder/classify.mts';
import { pr } from './fixtures.mts';

describe('classifyPullRequests', () => {
  it('groups a PR under each remaining requested team', () => {
    const pullRequest = pr({ requestedTeams: ['a', 'b'] });
    const result = classifyPullRequests([pullRequest], { fallbackTeam: 'f' });
    expect(result.byTeam.a).toStrictEqual([pullRequest]);
    expect(result.byTeam.b).toStrictEqual([pullRequest]);
  });

  it('lists PRs with no teams under the fallback, approved or not', () => {
    const pullRequest = pr();
    const result = classifyPullRequests([pullRequest], { fallbackTeam: 'f' });
    expect(result.fallback.noTeam).toStrictEqual([pullRequest]);
  });

  it('filters other teams out when ownerTeams is set', () => {
    const pullRequest = pr({ requestedTeams: ['ui', 'extension-platform'] });
    const result = classifyPullRequests([pullRequest], {
      ownerTeams: ['extension-platform'],
      fallbackTeam: 'f',
    });
    expect(Object.keys(result.byTeam)).toStrictEqual(['extension-platform']);
    expect(result.byTeam['extension-platform']).toStrictEqual([pullRequest]);
  });

  it('lists a PR under the fallback when ownerTeams leaves nothing', () => {
    const pullRequest = pr({ requestedTeams: ['ui'] });
    const result = classifyPullRequests([pullRequest], {
      ownerTeams: ['extension-platform'],
      fallbackTeam: 'f',
    });
    expect(result.byTeam).toStrictEqual({});
    expect(result.fallback.noTeam).toStrictEqual([pullRequest]);
  });

  it('normalizes team names before comparing and grouping', () => {
    const pullRequest = pr({ requestedTeams: ['MetaMask/UI', 'Core'] });
    const result = classifyPullRequests([pullRequest], {
      ownerTeams: ['@metamask/core'],
      fallbackTeam: 'f',
    });
    expect(Object.keys(result.byTeam)).toStrictEqual(['core']);
  });

  it('keeps a PR under its teams when it has exactly the threshold', () => {
    const pullRequest = pr({ requestedTeams: ['a', 'b', 'c', 'd', 'e'] });
    const result = classifyPullRequests([pullRequest], { fallbackTeam: 'f' });
    expect(Object.keys(result.byTeam)).toStrictEqual(['a', 'b', 'c', 'd', 'e']);
    expect(result.fallback.sharedByManyTeams).toStrictEqual([]);
  });

  it('moves a PR with more teams than the threshold to the fallback', () => {
    const pullRequest = pr({ requestedTeams: ['a', 'b', 'c', 'd', 'e', 'f'] });
    const result = classifyPullRequests([pullRequest], { fallbackTeam: 'f' });
    expect(result.byTeam).toStrictEqual({});
    expect(result.fallback.sharedByManyTeams).toStrictEqual([pullRequest]);
  });

  it('uses a custom threshold', () => {
    const pullRequest = pr({ requestedTeams: ['a', 'b'] });
    const result = classifyPullRequests([pullRequest], {
      fallbackTeam: 'f',
      sharedTeamThreshold: 1,
    });
    expect(result.fallback.sharedByManyTeams).toStrictEqual([pullRequest]);
  });

  it('counts only the owner teams and ignores repeats', () => {
    const pullRequest = pr({
      requestedTeams: ['a', 'A', 'b', 'x', 'y', 'z'],
    });
    const result = classifyPullRequests([pullRequest], {
      ownerTeams: ['a', 'b'],
      fallbackTeam: 'f',
    });
    expect(Object.keys(result.byTeam)).toStrictEqual(['a', 'b']);
    expect(result.fallback.sharedByManyTeams).toStrictEqual([]);
  });
});
