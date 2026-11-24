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

  it('keeps a failing CI PR under its team, since the team fixes it', () => {
    const pullRequest = pr({ ciState: 'failing', requestedTeams: ['a'] });
    const result = classifyPullRequests([pullRequest], { fallbackTeam: 'f' });
    expect(result.byTeam.a).toStrictEqual([pullRequest]);
    expect(result.fallback.needsOwner).toStrictEqual([]);
  });

  it('lists a failing CI PR with no team as needs owner', () => {
    const pullRequest = pr({ ciState: 'failing' });
    const result = classifyPullRequests([pullRequest], { fallbackTeam: 'f' });
    expect(result.fallback.needsOwner).toStrictEqual([pullRequest]);
  });

  it('lists approved PRs with no teams left as ready to merge', () => {
    const pullRequest = pr({ requestedTeams: [], hasApproval: true });
    const result = classifyPullRequests([pullRequest], { fallbackTeam: 'f' });
    expect(result.fallback.readyToMerge).toStrictEqual([pullRequest]);
  });

  it('lists PRs with no teams and no approval as needs owner', () => {
    const pullRequest = pr();
    const result = classifyPullRequests([pullRequest], { fallbackTeam: 'f' });
    expect(result.fallback.needsOwner).toStrictEqual([pullRequest]);
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

  it('lists approved PRs as ready to merge when ownerTeams leaves nothing', () => {
    const pullRequest = pr({ requestedTeams: ['ui'], hasApproval: true });
    const result = classifyPullRequests([pullRequest], {
      ownerTeams: ['extension-platform'],
      fallbackTeam: 'f',
    });
    expect(result.byTeam).toStrictEqual({});
    expect(result.fallback.readyToMerge).toStrictEqual([pullRequest]);
  });

  it('normalizes team names before comparing and grouping', () => {
    const pullRequest = pr({ requestedTeams: ['MetaMask/UI', 'Core'] });
    const result = classifyPullRequests([pullRequest], {
      ownerTeams: ['@metamask/core'],
      fallbackTeam: 'f',
    });
    expect(Object.keys(result.byTeam)).toStrictEqual(['core']);
  });
});
