import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pr } from './fixtures.mts';
import { classifyPullRequests } from '../../dependabot-pr-reminder/classify.mts';

describe('classifyPullRequests', () => {
  it('groups a PR under each remaining requested team', () => {
    const pullRequest = pr({ requestedTeams: ['a', 'b'] });
    const result = classifyPullRequests([pullRequest], { fallbackTeam: 'f' });
    assert.deepEqual(result.byTeam.a, [pullRequest]);
    assert.deepEqual(result.byTeam.b, [pullRequest]);
  });

  it('lists failing CI PRs under fallback only', () => {
    const pullRequest = pr({ ciFailing: true, requestedTeams: ['a'] });
    const result = classifyPullRequests([pullRequest], { fallbackTeam: 'f' });
    assert.deepEqual(result.fallback.failingCi, [pullRequest]);
    assert.deepEqual(result.byTeam, {});
  });

  it('lists approved PRs with no teams left as ready to merge', () => {
    const pullRequest = pr({ requestedTeams: [], hasApproval: true });
    const result = classifyPullRequests([pullRequest], { fallbackTeam: 'f' });
    assert.deepEqual(result.fallback.readyToMerge, [pullRequest]);
  });

  it('lists PRs with no teams and no approval as needs owner', () => {
    const pullRequest = pr();
    const result = classifyPullRequests([pullRequest], { fallbackTeam: 'f' });
    assert.deepEqual(result.fallback.needsOwner, [pullRequest]);
  });

  it('filters other teams out when ownerTeams is set', () => {
    const pullRequest = pr({ requestedTeams: ['ui', 'extension-platform'] });
    const result = classifyPullRequests([pullRequest], {
      ownerTeams: ['extension-platform'],
      fallbackTeam: 'f',
    });
    assert.deepEqual(Object.keys(result.byTeam), ['extension-platform']);
    assert.deepEqual(result.byTeam['extension-platform'], [pullRequest]);
  });

  it('lists approved PRs as ready to merge when ownerTeams leaves nothing', () => {
    const pullRequest = pr({ requestedTeams: ['ui'], hasApproval: true });
    const result = classifyPullRequests([pullRequest], {
      ownerTeams: ['extension-platform'],
      fallbackTeam: 'f',
    });
    assert.deepEqual(result.byTeam, {});
    assert.deepEqual(result.fallback.readyToMerge, [pullRequest]);
  });

  it('normalizes team names before comparing and grouping', () => {
    const pullRequest = pr({ requestedTeams: ['MetaMask/UI', 'Core'] });
    const result = classifyPullRequests([pullRequest], {
      ownerTeams: ['@metamask/core'],
      fallbackTeam: 'f',
    });
    assert.deepEqual(Object.keys(result.byTeam), ['core']);
  });
});
