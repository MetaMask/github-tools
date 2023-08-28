import path from 'path';

import { fetchOrPopulateFileCache } from '../../cache-utils';
import { CACHE_DIR } from '../../constants';
import type {
  GitHubComment,
  GitHubPageInfo,
} from '../../github/pull-request-comments-query';
import { makeGitHubPullRequestCommentsQuery } from '../../github/pull-request-comments-query';
import { log } from '../../logging-utils';

const CONTRIBUTOR_DOCS_REPO_NAME = 'contributor-docs';

/**
 * Counts the number of comments made to pull requests for the given MetaMask
 * repository that refer in some way to the `contributor-docs` repository.
 *
 * @param args - The arguments to this function.
 * @param args.repositoryName - The name of the MetaMask repository.
 * @param args.sampleSize - The maximum number of pull request comments to
 * consider when looking for references.
 * @returns The number of comments.
 */
export async function countCommentsWithReferencesToContributorDocs({
  repositoryName,
  sampleSize,
}: {
  repositoryName: string;
  sampleSize: number;
}): Promise<number> {
  const allComments = await fetchRepositoryPullRequestComments({
    repositoryName,
    maximum: sampleSize,
  });
  const commentsFromMetaMaskEngineers =
    selectCommentsFromMetaMaskEngineers(allComments);
  log(
    'Number of comments from MetaMask engineers',
    commentsFromMetaMaskEngineers.length,
  );
  const commentsWithReferencesToDocs =
    selectCommentsWithReferencesToContributorDocs(
      commentsFromMetaMaskEngineers,
    );
  return commentsWithReferencesToDocs.length;
}

/**
 * Collects a set number of the most recent comments made on pull requests
 * submitted for the given MetaMask repository.
 *
 * @param args - The arguments to this function.
 * @param args.repositoryName - The name of the repository.
 * @param args.maximum - The maximum number of comments to collect for the
 * repository.
 * @returns The comments.
 */
async function fetchRepositoryPullRequestComments({
  repositoryName,
  maximum,
}: {
  repositoryName: string;
  maximum: number;
}): Promise<GitHubComment[]> {
  return await fetchOrPopulateFileCache({
    filePath: path.join(
      CACHE_DIR,
      'pullRequestComments',
      `${repositoryName}.json`,
    ),
    getDataToCache: async () => {
      let allComments: GitHubComment[] = [];
      let pullRequestsPageInfo: GitHubPageInfo | undefined;
      while (
        allComments.length < maximum &&
        (pullRequestsPageInfo === undefined || pullRequestsPageInfo.hasNextPage)
      ) {
        const response = await fetchPageOfRepositoryPullRequestComments({
          repositoryName,
          after: pullRequestsPageInfo?.endCursor,
        });
        allComments = allComments.concat(response.comments);
        pullRequestsPageInfo = response.pullRequestsPageInfo;
      }
      return allComments;
    },
  });
}

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
async function fetchPageOfRepositoryPullRequestComments({
  repositoryName,
  after,
}: {
  repositoryName: string;
  after: string | undefined;
}): Promise<{
  comments: GitHubComment[];
  pullRequestsPageInfo: GitHubPageInfo;
}> {
  log(
    `Fetching pull requests for ${repositoryName}${
      after ? ` (after: ${after})` : ''
    }`,
  );

  const response = await makeGitHubPullRequestCommentsQuery({
    repositoryName,
    after,
  });

  const comments = response.repository.pullRequests.nodes.flatMap(
    (pullRequest) => pullRequest.comments.nodes,
  );
  return {
    comments,
    pullRequestsPageInfo: response.repository.pullRequests.pageInfo,
  };
}

/**
 * Comments on pull requests can be authored by people or by bots. We are only
 * interested in comments from MetaMask engineers.
 *
 * @param comments - A list of comments retrieved via the GitHub API.
 * @returns Only the comments that are from MetaMask engineers.
 */
function selectCommentsFromMetaMaskEngineers(
  comments: GitHubComment[],
): GitHubComment[] {
  return comments.filter((comment) => {
    return (
      comment.author !== undefined &&
      comment.author !== null &&
      comment.author.__typename !== 'Bot' &&
      comment.author.login !== 'metamaskbot' &&
      Boolean(comment.author.metamaskOrganization)
    );
  });
}

/**
 * Filters the list of comments to only those that reference the
 * `contributor-docs` repo. At the moment, we discern this by looking for
 * hyperlinks to the repo itself.
 *
 * @param comments - TODO.
 * @returns TODO.
 */
function selectCommentsWithReferencesToContributorDocs(
  comments: GitHubComment[],
): GitHubComment[] {
  return comments.filter((comment) => {
    return comment.body
      .toLowerCase()
      .includes(`github.com/metamask/${CONTRIBUTOR_DOCS_REPO_NAME}`);
  });
}
