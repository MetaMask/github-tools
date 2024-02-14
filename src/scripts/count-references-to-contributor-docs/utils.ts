import { DateTime } from 'luxon';
import path from 'path';

import { fetchOrPopulateFileCache } from '../../cache-utils';
import { CACHE_DIR } from '../../constants';
import type {
  GitHubComment,
  GitHubPullRequest,
} from '../../github/pull-request-comments-query';
import { makeGitHubPullRequestCommentsQuery } from '../../github/pull-request-comments-query';
import { log } from '../../logging-utils';

const CONTRIBUTOR_DOCS_REPO_NAME = 'contributor-docs';

export type TalliedQuarter = {
  number: number;
  year: number;
  name: string;
  sortKey: number;
  total: number;
};

/**
 * Counts the number of comments posted to pull requests for the given MetaMask
 * repository since the given date that refer in some way to the
 * `contributor-docs` repository, grouping them by quarter.
 *
 * @param args - The arguments to this function.
 * @param args.repositoryName - The name of the MetaMask repository.
 * @param args.since - Specifies the range of pull requests and comments to
 * fetch, starting at this date.
 * @returns The number of comments.
 */
export async function tallyCommentsWithReferencesToContributorDocsByQuarter({
  repositoryName,
  since,
}: {
  repositoryName: string;
  since: Date;
}): Promise<TalliedQuarter[]> {
  const pullRequests = await fetchRepositoryPullRequests({
    repositoryName,
    since,
  });
  log('Total number of pull requests to consider', pullRequests.length);

  const comments = pullRequests
    .flatMap((pullRequest) => {
      return [
        ...pullRequest.comments.nodes,
        ...pullRequest.reviews.nodes.flatMap((review) => review.comments.nodes),
      ];
    })
    .filter((comment) => {
      return new Date(comment.createdAt).getTime() >= since.getTime();
    });
  log('Total number of comments to consider', comments.length);

  const quartersBySortKey = comments.reduce<Map<number, TalliedQuarter>>(
    (map, comment) => {
      const createdDate = DateTime.fromISO(comment.createdAt, { zone: 'utc' });
      const quarterNumber = Math.floor((createdDate.month - 1) / 3) + 1;
      if (createdDate.month === 12 && createdDate.year === 2023) {
        console.log(
          'createdDate',
          createdDate.toISO(),
          'quarterNumber',
          quarterNumber,
        );
      }
      const sortKey = parseInt(`${createdDate.year}0${quarterNumber}`, 10);
      const quarter: TalliedQuarter = map.get(sortKey) ?? {
        number: quarterNumber,
        year: createdDate.year,
        name: `Q${quarterNumber}-${createdDate.year}`,
        sortKey,
        total: 0,
      };
      const newTotal =
        isFromMetaMaskEngineer(comment) &&
        hasReferenceToContributorDocs(comment)
          ? quarter.total + 1
          : quarter.total;
      map.set(quarter.sortKey, { ...quarter, total: newTotal });
      return map;
    },
    new Map(),
  );

  const quarterSortKeysFromLatestToEarliest = [
    ...quartersBySortKey.keys(),
  ].sort((quarterSortKey1, quarterSortKey2) => {
    return quarterSortKey1 - quarterSortKey2;
  });

  return quarterSortKeysFromLatestToEarliest.map(
    // We can assume that this value is present since we set it above.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    (quarterSortKey) => quartersBySortKey.get(quarterSortKey)!,
  );
}

/**
 * Collects the pull requests under the the given MetaMask repository that have
 * been created on or after the given date, along with their comments that have
 * been created on or after the given date.
 *
 * @param args - The arguments to this function.
 * @param args.repositoryName - The name of the repository.
 * @param args.since - Specifies the range of pull requests and comments to
 * fetch, starting at this date.
 * @returns The comments.
 */
async function fetchRepositoryPullRequests({
  repositoryName,
  since,
}: {
  repositoryName: string;
  since: Date;
}): Promise<GitHubPullRequest[]> {
  return await fetchOrPopulateFileCache({
    filePath: path.join(
      CACHE_DIR,
      'pullRequestComments',
      `${repositoryName}-since-${since.getTime()}.json`,
    ),
    getDataToCache: async () => {
      const allPullRequests: GitHubPullRequest[] = [];
      let pullRequestsPageInfo: {
        hasNextPage: boolean;
        endCursor?: string;
      } = {
        hasNextPage: true,
      };

      while (pullRequestsPageInfo.hasNextPage) {
        const response = await makeGitHubPullRequestCommentsQuery({
          repositoryName,
          after: pullRequestsPageInfo.endCursor,
        });
        const pullRequests = response.repository.pullRequests.nodes;

        const filteredPullRequests = pullRequests.filter(
          (pullRequest) =>
            new Date(pullRequest.createdAt).getTime() >= since.getTime() ||
            pullRequest.comments.nodes.some((comment) => {
              return new Date(comment.createdAt).getTime() >= since.getTime();
            }) ||
            pullRequest.reviews.nodes.some((review) => {
              return review.comments.nodes.some((comment) => {
                return new Date(comment.createdAt).getTime() >= since.getTime();
              });
            }),
        );

        allPullRequests.push(...filteredPullRequests);
        pullRequestsPageInfo = {
          ...response.repository.pullRequests.pageInfo,
          hasNextPage:
            response.repository.pullRequests.pageInfo.hasNextPage &&
            filteredPullRequests.length === pullRequests.length,
        };
      }

      return allPullRequests;
    },
  });
}

/**
 * Comments on pull requests can be authored by people or by bots. We are only
 * interested in comments from MetaMask engineers.
 *
 * @param comment - A comment retrieved via the GitHub API.
 * @returns True if the comment was posted by a MetaMask engineer, false
 * otherwise.
 */
function isFromMetaMaskEngineer(comment: GitHubComment): boolean {
  return (
    comment.author !== undefined &&
    comment.author !== null &&
    comment.author.__typename !== 'Bot' &&
    comment.author.login !== 'metamaskbot' &&
    Boolean(comment.author.metamaskOrganization)
  );
}

/**
 * We are only interested in comments that refer to the contributor-docs repo.
 * There are many ways to do this, but at the moment, we look for a
 * hyperlink to the repo itself.
 *
 * @param comment - A comment retrieved via the GitHub API.
 * @returns True if the comment contains a link to the `contributor-docs` repo,
 * false otherwise.
 */
function hasReferenceToContributorDocs(comment: GitHubComment): boolean {
  return (
    comment.body
      .toLowerCase()
      .includes(`github.com/metamask/${CONTRIBUTOR_DOCS_REPO_NAME}`) ||
    comment.body.toLowerCase().includes('contributor docs')
  );
}
