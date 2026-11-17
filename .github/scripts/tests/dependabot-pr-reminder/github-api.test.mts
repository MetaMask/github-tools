import { describe, expect, it } from 'vitest';

import {
  buildTopologyPath,
  collectRequestedTeams,
  toPullRequest,
} from '../../dependabot-pr-reminder/github-api.mts';
import type { GraphQlPullRequestNode } from '../../dependabot-pr-reminder/github-api.mts';

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
    // eslint-disable-next-line @typescript-eslint/naming-convention
    author: { __typename: 'Bot', login: 'dependabot' },
    latestOpinionatedReviews: { nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
    ...overrides,
  };
}

describe('toPullRequest', () => {
  it('returns undefined for drafts', () => {
    expect(toPullRequest(node({ isDraft: true }), [])).toBeUndefined();
  });

  it('returns undefined for non-Dependabot authors', () => {
    expect(
      toPullRequest(
        // eslint-disable-next-line @typescript-eslint/naming-convention
        node({ author: { __typename: 'Bot', login: 'someone-else' } }),
        [],
      ),
    ).toBeUndefined();
  });

  it('rejects a User named dependabot', () => {
    expect(
      toPullRequest(
        // eslint-disable-next-line @typescript-eslint/naming-convention
        node({ author: { __typename: 'User', login: 'dependabot' } }),
        [],
      ),
    ).toBeUndefined();
  });

  it('accepts a Bot named dependabot[bot]', () => {
    expect(
      toPullRequest(
        // eslint-disable-next-line @typescript-eslint/naming-convention
        node({ author: { __typename: 'Bot', login: 'dependabot[bot]' } }),
        [],
      )?.number,
    ).toBe(7);
  });

  it('returns undefined when the author is missing', () => {
    expect(toPullRequest(node({ author: null }), [])).toBeUndefined();
  });

  it('maps a Dependabot PR', () => {
    expect(toPullRequest(node(), [])).toStrictEqual({
      number: 7,
      title: 'Bump foo',
      url: 'https://github.com/MetaMask/example/pull/7',
      requestedTeams: [],
      hasApproval: false,
      ciFailing: false,
    });
  });

  it('uses the given requested teams', () => {
    expect(toPullRequest(node(), ['wallet'])?.requestedTeams).toStrictEqual([
      'wallet',
    ]);
  });

  it('sets hasApproval when approved and nothing requests changes', () => {
    const result = (states: string[]): boolean | undefined =>
      toPullRequest(
        node({
          latestOpinionatedReviews: {
            nodes: states.map((state) => ({ state })),
          },
        }),
        [],
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
        node({
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup,
                },
              },
            ],
          },
        }),
        [],
      )?.ciFailing;
    expect(rollup({ state: 'FAILURE' })).toBe(true);
    expect(rollup({ state: 'ERROR' })).toBe(true);
    expect(rollup({ state: 'PENDING' })).toBe(false);
    expect(rollup({ state: 'SUCCESS' })).toBe(false);
    expect(rollup(null)).toBe(false);
  });
});

/* eslint-disable @typescript-eslint/naming-convention */
describe('collectRequestedTeams', () => {
  it('maps PR numbers to requested team slugs across pages', () => {
    const map = collectRequestedTeams([
      [{ number: 1, requested_teams: [{ slug: 'a' }, { slug: 'b' }] }],
      [{ number: 2, requested_teams: [] }, { number: 3 }],
    ]);
    expect(map.get(1)).toStrictEqual(['a', 'b']);
    expect(map.get(2)).toStrictEqual([]);
    expect(map.get(3)).toBeUndefined();
    expect(map.get(4)).toBeUndefined();
  });
});

/* eslint-enable @typescript-eslint/naming-convention */

describe('buildTopologyPath', () => {
  it('encodes the ref', () => {
    expect(buildTopologyPath('feat/a b#c')).toBe(
      'repos/MetaMask/MetaMask-planning/contents/topology.json?ref=feat%2Fa%20b%23c',
    );
  });
});
