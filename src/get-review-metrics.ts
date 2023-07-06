import { Octokit, RestEndpointMethodTypes } from '@octokit/rest';
import { DateTime } from 'luxon';

const octokit = new Octokit();

const TEAM_NAME = 'Extension Platform Team';
const INTERNAL_DESCRIPTOR = `PRs opened by members of the ${TEAM_NAME}`;
const EXTERNAL_DESCRIPTOR = `PRs opened by authors not on the ${TEAM_NAME}`;

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
 * Get all review comments for the repository specified.
 *
 * @param page - The page number of results to fetch.
 */
async function getAllComments(page = 1) {
  const { data } = await octokit.rest.pulls.listReviewCommentsForRepo({
    owner: 'MetaMask',
    repo: 'metamask-extension',
    since: DateTime.now().minus({ days: 14 }).toISODate() as string,
    // eslint-disable-next-line
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
 * Main executable method for the script.
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
  console.log('Category:', INTERNAL_DESCRIPTOR);
  console.log('# of total Pull Requests for category:', internalPulls);
  console.log(
    '# of total review comments for category:',
    internalPullReviewComments,
  );
  console.log('Category:', EXTERNAL_DESCRIPTOR);
  console.log('# of total Pull Requests for category:', externalPulls);
  console.log(
    '# of total review comments for category: ',
    externalPullReviewComments,
  );
}

execute()
  .then(() => {
    /* noop */
  })
  .catch((error) => console.error(error));
