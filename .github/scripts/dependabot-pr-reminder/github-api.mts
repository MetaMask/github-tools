import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { PullRequest } from './types.mts';
import { retry } from '../shared/retry.mts';

const execFileAsync = promisify(execFile);

export type GraphQlPullRequestNode = {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  // eslint-disable-next-line @typescript-eslint/naming-convention
  author: { __typename: string; login: string } | null;
  latestOpinionatedReviews: { nodes: { state: string }[] };
  commits: {
    nodes: { commit: { statusCheckRollup: { state: string } | null } }[];
  };
};

/**
 * Maps a GraphQL pull request node to a PullRequest.
 *
 * @param node - The GraphQL node.
 * @param requestedTeams - The team slugs requested for review (from REST).
 * @returns The pull request, or undefined for drafts and non-Dependabot PRs.
 */
export function toPullRequest(
  node: GraphQlPullRequestNode,
  requestedTeams: string[],
): PullRequest | undefined {
  // GraphQL returns `dependabot` for the Bot actor; REST returns
  // `dependabot[bot]`. Accept both, but only for Bot actors.
  if (
    node.isDraft ||
    node.author?.__typename !== 'Bot' ||
    (node.author.login !== 'dependabot' &&
      node.author.login !== 'dependabot[bot]')
  ) {
    return undefined;
  }

  const rollupState =
    node.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null;

  return {
    number: node.number,
    title: node.title,
    url: node.url,
    requestedTeams,
    hasApproval:
      node.latestOpinionatedReviews.nodes.some(
        ({ state }) => state === 'APPROVED',
      ) &&
      !node.latestOpinionatedReviews.nodes.some(
        ({ state }) => state === 'CHANGES_REQUESTED',
      ),
    ciFailing: rollupState === 'FAILURE' || rollupState === 'ERROR',
  };
}

/**
 * Builds a map of PR number to requested team slugs from REST pull request
 * pages.
 *
 * @param pages - The paginated REST responses.
 * @returns The requested team slugs by PR number.
 */
export function collectRequestedTeams(
  pages: {
    number: number;
    // eslint-disable-next-line @typescript-eslint/naming-convention
    requested_teams?: { slug: string }[];
  }[][],
): Map<number, string[]> {
  const result = new Map<number, string[]>();
  for (const restPullRequest of pages.flat()) {
    if (restPullRequest.requested_teams) {
      result.set(
        restPullRequest.number,
        restPullRequest.requested_teams.map(({ slug }) => slug),
      );
    }
  }
  return result;
}

/**
 * Builds the REST path to read topology.json at a ref.
 *
 * @param ref - The git ref.
 * @returns The `gh api` path.
 */
export function buildTopologyPath(ref: string): string {
  return `repos/MetaMask/MetaMask-planning/contents/topology.json?ref=${encodeURIComponent(ref)}`;
}

export const PULL_REQUESTS_QUERY = `
query($owner: String!, $name: String!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 100, after: $endCursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        title
        url
        isDraft
        author { __typename login }
        latestOpinionatedReviews(first: 20) { nodes { state } }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`;

/**
 * Runs `gh api`, retrying transient failures.
 *
 * @param argumentsList - Arguments after `gh api`.
 * @param token - The token passed as GH_TOKEN, if different from the default.
 * @param environment - The base environment.
 * @returns The standard output.
 */
export async function ghApi(
  argumentsList: string[],
  token: string | undefined,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  return await retry(
    async () => {
      const { stdout } = await execFileAsync('gh', ['api', ...argumentsList], {
        env: token ? { ...environment, GH_TOKEN: token } : environment,
        maxBuffer: 100 * 1024 * 1024,
      });
      return stdout;
    },
    { maxAttempts: 3, delayMilliseconds: 2_000 },
  );
}
