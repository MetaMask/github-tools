import { describe, expect, it, vi } from 'vitest';

import {
  buildSearchQuery,
  fetchDependabotPullRequests,
  toPullRequest,
  toPullRequests,
} from '../../dependabot-pr-reminder/github-api.mts';
import type {
  GraphQlPullRequestNode,
  SearchPage,
} from '../../dependabot-pr-reminder/github-api.mts';

/**
 * Builds a search node for tests.
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
    author: { __typename: 'Bot', login: 'dependabot' },
    reviewRequests: { nodes: [] },
    latestOpinionatedReviews: { nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
    ...overrides,
  };
}

describe('toPullRequest', () => {
  it('returns undefined for search nodes that are not pull requests', () => {
    expect(toPullRequest({})).toBeUndefined();
  });

  it('returns undefined for drafts', () => {
    expect(toPullRequest(node({ isDraft: true }))).toBeUndefined();
  });

  it('returns undefined for non-Dependabot authors', () => {
    expect(
      toPullRequest(node({ author: { __typename: 'Bot', login: 'other' } })),
    ).toBeUndefined();
  });

  it('rejects a User named dependabot', () => {
    expect(
      toPullRequest(
        node({ author: { __typename: 'User', login: 'dependabot' } }),
      ),
    ).toBeUndefined();
  });

  it('accepts a Bot named dependabot[bot]', () => {
    expect(
      toPullRequest(
        node({ author: { __typename: 'Bot', login: 'dependabot[bot]' } }),
      )?.number,
    ).toBe(7);
  });

  it('returns undefined when the author is missing', () => {
    expect(toPullRequest(node({ author: null }))).toBeUndefined();
  });

  it('maps a Dependabot PR', () => {
    expect(toPullRequest(node())).toStrictEqual({
      number: 7,
      title: 'Bump foo',
      url: 'https://github.com/MetaMask/example/pull/7',
      requestedTeams: [],
      hasApproval: false,
      ciFailing: false,
    });
  });

  it('keeps requested teams and ignores requested users', () => {
    const pullRequest = toPullRequest(
      node({
        reviewRequests: {
          nodes: [
            { requestedReviewer: { __typename: 'Team', slug: 'wallet' } },
            { requestedReviewer: { __typename: 'User' } },
            { requestedReviewer: null },
          ],
        },
      }),
    );
    expect(pullRequest?.requestedTeams).toStrictEqual(['wallet']);
  });

  it('sets hasApproval when approved and nothing requests changes', () => {
    const result = (states: string[]): boolean | undefined =>
      toPullRequest(
        node({
          latestOpinionatedReviews: {
            nodes: states.map((state) => ({ state })),
          },
        }),
      )?.hasApproval;
    expect(result(['APPROVED'])).toBe(true);
    expect(result(['APPROVED', 'CHANGES_REQUESTED'])).toBe(false);
    expect(result(['CHANGES_REQUESTED'])).toBe(false);
    expect(result([])).toBe(false);
  });

  it('sets ciFailing only for FAILURE and ERROR', () => {
    const rollup = (
      statusCheckRollup: { state: string } | null,
    ): boolean | undefined =>
      toPullRequest(
        node({ commits: { nodes: [{ commit: { statusCheckRollup } }] } }),
      )?.ciFailing;
    expect(rollup({ state: 'FAILURE' })).toBe(true);
    expect(rollup({ state: 'ERROR' })).toBe(true);
    expect(rollup({ state: 'PENDING' })).toBe(false);
    expect(rollup({ state: 'SUCCESS' })).toBe(false);
    expect(rollup(null)).toBe(false);
  });
});

describe('toPullRequests', () => {
  it('flattens pages and drops nodes that do not qualify', () => {
    const pages: SearchPage[] = [
      { data: { search: { nodes: [node({ number: 1 }), {}] } } },
      { data: { search: { nodes: [node({ number: 2, isDraft: true })] } } },
      { data: { search: { nodes: [node({ number: 3 })] } } },
    ];
    expect(toPullRequests(pages).map(({ number }) => number)).toStrictEqual([
      1, 3,
    ]);
  });
});

describe('buildSearchQuery', () => {
  it('filters to open, non draft Dependabot pull requests', () => {
    expect(buildSearchQuery('MetaMask/core')).toBe(
      'repo:MetaMask/core is:pr is:open draft:false author:app/dependabot',
    );
  });
});

describe('fetchDependabotPullRequests', () => {
  it('needs a single gh call for a repository with one page of PRs', async () => {
    const page: SearchPage = {
      data: { search: { nodes: [node({ number: 11 })] } },
    };
    const run = vi
      .fn<() => Promise<string>>()
      .mockResolvedValue(JSON.stringify([page]));
    const pullRequests = await fetchDependabotPullRequests('MetaMask/core', {
      environment: {},
      run,
    });
    expect(pullRequests.map(({ number }) => number)).toStrictEqual([11]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]).toStrictEqual([
      expect.arrayContaining([
        'graphql',
        '--paginate',
        '--slurp',
        `searchQuery=${buildSearchQuery('MetaMask/core')}`,
      ]),
      {},
    ]);
  });
});
