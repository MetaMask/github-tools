import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildSlackPayload,
  classifyPullRequests,
  normalizeTeam,
  parseOwnerTeams,
  toPullRequest,
} from '../dependabot-pr-reminder.mts';
import type {
  GraphQlPullRequestNode,
  PullRequest,
  Reminder,
} from '../dependabot-pr-reminder.mts';

/**
 * Builds a pull request for tests.
 *
 * @param overrides - Fields to override on the default pull request.
 * @returns The pull request.
 */
function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 1,
    title: 'Bump foo from 1.0.0 to 1.0.1',
    url: 'https://github.com/MetaMask/example/pull/1',
    requestedTeams: [],
    hasApproval: false,
    ciFailing: false,
    ...overrides,
  };
}

describe('normalizeTeam', () => {
  it('lowercases and strips the @ and metamask/ prefixes', () => {
    assert.equal(normalizeTeam('@MetaMask/Core-Platform'), 'core-platform');
  });
});

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

/**
 * Builds a GraphQL node for tests.
 *
 * @param overrides - Fields to override.
 * @returns The node.
 */
function node(
  overrides: Partial<GraphQlPullRequestNode> = {},
): GraphQlPullRequestNode {
  return {
    number: 7,
    title: 'Bump foo',
    url: 'https://github.com/MetaMask/example/pull/7',
    isDraft: false,
    author: { login: 'dependabot[bot]' },
    reviewRequests: { nodes: [] },
    latestOpinionatedReviews: { nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
    ...overrides,
  };
}

describe('toPullRequest', () => {
  it('returns undefined for drafts', () => {
    assert.equal(toPullRequest(node({ isDraft: true })), undefined);
  });

  it('returns undefined for non-Dependabot authors', () => {
    assert.equal(
      toPullRequest(node({ author: { login: 'someone-else' } })),
      undefined,
    );
  });

  it('returns undefined when the author is missing', () => {
    assert.equal(toPullRequest(node({ author: null })), undefined);
  });

  it('maps a Dependabot PR', () => {
    assert.deepEqual(toPullRequest(node()), {
      number: 7,
      title: 'Bump foo',
      url: 'https://github.com/MetaMask/example/pull/7',
      requestedTeams: [],
      hasApproval: false,
      ciFailing: false,
    });
  });

  it('keeps Team reviewers and ignores Users', () => {
    const result = toPullRequest(
      node({
        reviewRequests: {
          /* eslint-disable @typescript-eslint/naming-convention */
          nodes: [
            { requestedReviewer: { __typename: 'User' } },
            { requestedReviewer: { __typename: 'Team', slug: 'wallet' } },
            { requestedReviewer: null },
          ],
          /* eslint-enable @typescript-eslint/naming-convention */
        },
      }),
    );
    assert.deepEqual(result?.requestedTeams, ['wallet']);
  });

  it('sets hasApproval when any latest review is APPROVED', () => {
    const result = toPullRequest(
      node({
        latestOpinionatedReviews: {
          nodes: [{ state: 'CHANGES_REQUESTED' }, { state: 'APPROVED' }],
        },
      }),
    );
    assert.equal(result?.hasApproval, true);
  });

  it('sets ciFailing only for FAILURE and ERROR', () => {
    const rollup = (state: string | null) =>
      toPullRequest(
        node({
          commits: {
            nodes: [
              { commit: { statusCheckRollup: state ? { state } : null } },
            ],
          },
        }),
      )?.ciFailing;
    assert.equal(rollup('FAILURE'), true);
    assert.equal(rollup('ERROR'), true);
    assert.equal(rollup('PENDING'), false);
    assert.equal(rollup('SUCCESS'), false);
    assert.equal(rollup(null), false);
  });
});

describe('parseOwnerTeams', () => {
  it('returns undefined for undefined, empty, and whitespace input', () => {
    assert.equal(parseOwnerTeams(undefined), undefined);
    assert.equal(parseOwnerTeams(''), undefined);
    assert.equal(parseOwnerTeams('  \n '), undefined);
    assert.equal(parseOwnerTeams(' , ,'), undefined);
  });

  it('splits, trims, and drops empty entries', () => {
    assert.deepEqual(parseOwnerTeams(' a, b ,,c '), ['a', 'b', 'c']);
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
