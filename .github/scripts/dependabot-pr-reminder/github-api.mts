import { ghGraphqlPages } from '../shared/github-cli.mts';
import type { GhOptions } from '../shared/github-cli.mts';
import type { PullRequest } from './types.mts';

export type GraphQlPullRequestNode = {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  author: { __typename: string; login: string } | null;
  reviewRequests: {
    nodes: {
      requestedReviewer: { __typename: string; slug?: string } | null;
    }[];
  };
  commits: {
    nodes: { commit: { statusCheckRollup: { state: string } | null } }[];
  };
};

/** A page of search results. Nodes that are not pull requests come back empty. */
export type SearchPage = {
  data: {
    search: { nodes: (GraphQlPullRequestNode | Record<string, never>)[] };
  };
};

/**
 * One query returns every field the reminder needs, including the requested
 * teams, so a run costs a single request per 100 pull requests. The search
 * filter keeps drafts and non Dependabot authors out on the server side.
 */
export const PULL_REQUESTS_QUERY = `
query($searchQuery: String!, $endCursor: String) {
  search(query: $searchQuery, type: ISSUE, first: 100, after: $endCursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number
        title
        url
        isDraft
        author { __typename login }
        reviewRequests(first: 20) {
          nodes { requestedReviewer { __typename ... on Team { slug } } }
        }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`;

/**
 * Builds the search string for open, non draft Dependabot pull requests.
 *
 * @param repository - The repository in `owner/name` form.
 * @returns The GitHub search query.
 */
export function buildSearchQuery(repository: string): string {
  return `repo:${repository} is:pr is:open draft:false author:app/dependabot`;
}

/**
 * Maps a commit status rollup to a CI state.
 *
 * @param rollupState - The GraphQL rollup state, or null when there are no
 * checks.
 * @returns The CI state.
 */
function toCiState(rollupState: string | null): PullRequest['ciState'] {
  if (rollupState === 'SUCCESS') {
    return 'passing';
  }
  if (rollupState === 'FAILURE' || rollupState === 'ERROR') {
    return 'failing';
  }
  if (rollupState === 'PENDING' || rollupState === 'EXPECTED') {
    return 'pending';
  }
  return 'unknown';
}

/**
 * Maps a search node to a PullRequest.
 *
 * @param node - The search node.
 * @returns The pull request, or undefined for non pull requests, drafts and
 * non Dependabot PRs. The server side search already filters those, this is a
 * safety net.
 */
export function toPullRequest(
  node: GraphQlPullRequestNode | Record<string, never>,
): PullRequest | undefined {
  if (!('number' in node)) {
    return undefined;
  }
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
    requestedTeams: node.reviewRequests.nodes.flatMap(
      ({ requestedReviewer }) =>
        requestedReviewer?.__typename === 'Team' && requestedReviewer.slug
          ? [requestedReviewer.slug]
          : [],
    ),
    ciState: toCiState(rollupState),
  };
}

/**
 * Maps search pages to pull requests.
 *
 * @param pages - The paginated search responses.
 * @returns The Dependabot pull requests.
 */
export function toPullRequests(pages: SearchPage[]): PullRequest[] {
  return pages
    .flatMap((page) => page.data.search.nodes)
    .map(toPullRequest)
    .filter((pullRequest): pullRequest is PullRequest => Boolean(pullRequest));
}

/**
 * Fetches the open Dependabot pull requests of a repository.
 *
 * @param repository - The repository in `owner/name` form.
 * @param gh - Options for the underlying `gh api` calls.
 * @returns The pull requests.
 */
export async function fetchDependabotPullRequests(
  repository: string,
  gh: GhOptions,
): Promise<PullRequest[]> {
  const pages = await ghGraphqlPages<SearchPage>(
    PULL_REQUESTS_QUERY,
    { searchQuery: buildSearchQuery(repository) },
    gh,
  );
  return toPullRequests(pages);
}
