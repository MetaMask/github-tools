import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

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
    assert.equal(toPullRequest(node({ isDraft: true }), []), undefined);
  });

  it('returns undefined for non-Dependabot authors', () => {
    assert.equal(
      toPullRequest(
        // eslint-disable-next-line @typescript-eslint/naming-convention
        node({ author: { __typename: 'Bot', login: 'someone-else' } }),
        [],
      ),
      undefined,
    );
  });

  it('rejects a User named dependabot', () => {
    assert.equal(
      toPullRequest(
        // eslint-disable-next-line @typescript-eslint/naming-convention
        node({ author: { __typename: 'User', login: 'dependabot' } }),
        [],
      ),
      undefined,
    );
  });

  it('accepts a Bot named dependabot[bot]', () => {
    assert.equal(
      toPullRequest(
        // eslint-disable-next-line @typescript-eslint/naming-convention
        node({ author: { __typename: 'Bot', login: 'dependabot[bot]' } }),
        [],
      )?.number,
      7,
    );
  });

  it('returns undefined when the author is missing', () => {
    assert.equal(toPullRequest(node({ author: null }), []), undefined);
  });

  it('maps a Dependabot PR', () => {
    assert.deepEqual(toPullRequest(node(), []), {
      number: 7,
      title: 'Bump foo',
      url: 'https://github.com/MetaMask/example/pull/7',
      requestedTeams: [],
      hasApproval: false,
      ciFailing: false,
    });
  });

  it('uses the given requested teams', () => {
    assert.deepEqual(toPullRequest(node(), ['wallet'])?.requestedTeams, [
      'wallet',
    ]);
  });

  it('sets hasApproval when approved and nothing requests changes', () => {
    const result = (states: string[]) =>
      toPullRequest(
        node({
          latestOpinionatedReviews: {
            nodes: states.map((state) => ({ state })),
          },
        }),
        [],
      )?.hasApproval;
    assert.equal(result(['APPROVED']), true);
    assert.equal(result(['APPROVED', 'CHANGES_REQUESTED']), false);
    assert.equal(result(['CHANGES_REQUESTED']), false);
    assert.equal(result([]), false);
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
        [],
      )?.ciFailing;
    assert.equal(rollup('FAILURE'), true);
    assert.equal(rollup('ERROR'), true);
    assert.equal(rollup('PENDING'), false);
    assert.equal(rollup('SUCCESS'), false);
    assert.equal(rollup(null), false);
  });
});

/* eslint-disable @typescript-eslint/naming-convention */
describe('collectRequestedTeams', () => {
  it('maps PR numbers to requested team slugs across pages', () => {
    const map = collectRequestedTeams([
      [{ number: 1, requested_teams: [{ slug: 'a' }, { slug: 'b' }] }],
      [{ number: 2, requested_teams: [] }, { number: 3 }],
    ]);
    assert.deepEqual(map.get(1), ['a', 'b']);
    assert.deepEqual(map.get(2), []);
    assert.equal(map.get(3), undefined);
    assert.equal(map.get(4), undefined);
  });
});

/* eslint-enable @typescript-eslint/naming-convention */

describe('buildTopologyPath', () => {
  it('encodes the ref', () => {
    assert.equal(
      buildTopologyPath('feat/a b#c'),
      'repos/MetaMask/MetaMask-planning/contents/topology.json?ref=feat%2Fa%20b%23c',
    );
  });
});
