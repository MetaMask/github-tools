import { Octokit, RestEndpointMethodTypes } from '@octokit/rest';
import { DateTime } from 'luxon';

const octokit = new Octokit();

const TEAM = [
  'PeterYinusa',
  'brad-decker',
  'DDDDDanica',
  'danjm',
  'pedronfigueiredo',
  'tmashuang',
  'chloeYue',
];

const results: RestEndpointMethodTypes['pulls']['listReviewCommentsForRepo']['response']['data'] =
  [];

type PullRequestData = {
  reviewComments: RestEndpointMethodTypes['pulls']['listReviewCommentsForRepo']['response']['data'];
  isInternal: boolean;
};
const pullRequests: {
  [prUrl: string]: PullRequestData;
} = {};

/**
 *
 * @param page
 */
async function getAllComments(page = 1) {
  const { data } = await octokit.rest.pulls.listReviewCommentsForRepo({
    owner: 'MetaMask',
    repo: 'metamask-extension',
    since: DateTime.now().minus({ days: 14 }).toISODate() as string,
    per_page: 100,
    page,
  });
  results.push(
    ...data.filter((comment) => {
      return TEAM.includes(comment.user.login);
    }),
  );
  if (data.length === 100) {
    return false;
  }
  return true;
}

/**
 *
 */
async function execute(): Promise<void> {
  let page = 1;
  while (!(await getAllComments(page))) {
    page += 1;
    console.log('fetching');
  }
  results.forEach((result) => {
    if (pullRequests[result.pull_request_url]) {
      pullRequests[result.pull_request_url]?.reviewComments.push(result);
    } else {
      pullRequests[result.pull_request_url] = {
        reviewComments: [result],
        isInternal: false,
      };
    }
  });
  const pulls = Object.keys(pullRequests);
  for (const pull of pulls) {
    const { data } = await octokit.request(pull);
    if (TEAM.includes(data.user.login) && pullRequests[pull]) {
      (pullRequests[pull] as PullRequestData).isInternal = true;
    }
  }
  let internalPulls = 0;
  let externalPulls = 0;
  let internalPullReviewComments = 0;
  let externalPullReviewComments = 0;
  pulls.forEach((pull) => {
    if (pullRequests[pull]?.isInternal) {
      internalPulls += 1;
      internalPullReviewComments +=
        pullRequests[pull]?.reviewComments?.length ?? 0;
    } else {
      externalPulls += 1;
      externalPullReviewComments +=
        pullRequests[pull]?.reviewComments?.length ?? 0;
    }
  });
  console.log('INTERNAL');
  console.log('Pull Requests: ', internalPulls);
  console.log('Pull Request Review Comments: ', internalPullReviewComments);
  console.log('External');
  console.log('Pull Requests: ', externalPulls);
  console.log('Pull Request Review Comments: ', externalPullReviewComments);
}

execute()
  .then(() => {
    /* noop */
  })
  .catch((error) => console.error(error));
