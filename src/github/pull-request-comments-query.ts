import { graphql } from './octokit';
import { log } from '../logging-utils';

type GitHubActorTypename =
  | 'EnterpriseUserAccount'
  | 'Organization'
  | 'Bot'
  | 'Mannequin'
  | 'User';

export type GitHubComment = {
  author?: {
    // This is the name of the GraphQL field.
    // eslint-disable-next-line @typescript-eslint/naming-convention
    __typename: GitHubActorTypename;
    login: string;
    metamaskOrganization?: {
      login: string;
    };
  };
  body: string;
  updatedAt: string;
};

type GitHubPullRequest = {
  number: number;
  comments: {
    nodes: GitHubComment[];
    pageInfo: GitHubPageInfo;
  };
  updatedAt: string;
};

export type GitHubPageInfo = {
  endCursor: string;
  hasNextPage: boolean;
};

type GitHubRateLimit = {
  limit: number;
  cost: number;
  remaining: number;
  resetAt: string;
};

type GitHubPullRequestCommentsQueryResponse = {
  repository: {
    name: string;
    updatedAt: string;
    pullRequests: {
      nodes: GitHubPullRequest[];
      pageInfo: GitHubPageInfo;
    };
  };
  rateLimit: GitHubRateLimit;
};

const QUERY = `
  query GetPullRequestComments($repositoryName: String!, $after: String) {
    repository(name: $repositoryName, owner: "MetaMask") {
      name
      updatedAt
      pullRequests(first: 100, orderBy: { field: UPDATED_AT, direction: DESC }, after: $after) {
        nodes {
          number
          comments(first: 100, orderBy: { field: UPDATED_AT, direction: DESC }) {
            nodes {
              author {
                __typename
                login
                ...on User {
                  metamaskOrganization: organization(login: "MetaMask") {
                    login
                  }
                }
              }
              body
              updatedAt
            }
          }
          updatedAt
        }
        pageInfo {
          endCursor
          hasNextPage
        }
      }
    }
    rateLimit {
      limit
      cost
      remaining
      resetAt
    }
  }
`;

/**
 * When requesting a collection of resources, the GitHub API returns a maximum
 * of 100 at a time. This function is used to retrieve a "page" of the most
 * recent comments made on pull requests submitted for the given MetaMask
 * repository.
 *
 * @param args - The arguments.
 * @param args.repositoryName - The name of the repository.
 * @param args.after - Returns the pull requests that come after this cursor.
 * @returns The comments.
 */
export async function makeGitHubPullRequestCommentsQuery({
  repositoryName,
  after,
}: {
  repositoryName: string;
  after: string | undefined;
}): Promise<GitHubPullRequestCommentsQueryResponse> {
  log(
    `Fetching pull requests for ${repositoryName}${
      after ? ` (after: ${after})` : ''
    }`,
  );

  return await graphql<GitHubPullRequestCommentsQueryResponse>(QUERY, {
    repositoryName,
    after,
  });
}
