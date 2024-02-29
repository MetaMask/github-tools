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
  createdAt: string;
  updatedAt: string;
};

type GitHubReview = {
  id: string;
  comments: {
    nodes: GitHubComment[];
  };
};

export type GitHubPullRequest = {
  number: number;
  comments: {
    nodes: GitHubComment[];
  };
  reviews: {
    nodes: GitHubReview[];
  };
  createdAt: string;
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
          createdAt
          updatedAt
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
              createdAt
              updatedAt
            }
          }
          reviews(first: 40) {
            nodes {
              id
              comments(first: 100) {
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
                  createdAt
                  updatedAt
                }
              }
            }
          }
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
 * Executes a GraphQL query to retrieve the most recent comments posted on pull
 * requests submitted for the given MetaMask repository, ordered from latest to
 * earliest. A cursor may be provided to retrieve a particular "page" of pull
 * requests.
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
    `Executing GraphQL query to fetch pull requests for ${repositoryName}${
      after ? ` (after: ${after})` : ''
    }`,
  );

  return await graphql<GitHubPullRequestCommentsQueryResponse>(QUERY, {
    repositoryName,
    after,
  });
}
