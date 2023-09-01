import { withCustomRequest } from '@octokit/graphql';
import type { graphql as octokitGraphql } from '@octokit/graphql';
import { request } from '@octokit/request';

import { getRequiredEnvironmentVariable } from '../env-utils';

/**
 * Makes a GraphQL request which is authenticated with a GitHub token.
 *
 * @param args - The same arguments that
 * [`graphql`](https://github.com/octokit/graphql.js) takes.
 */
export async function graphql<ResponseData>(
  ...args: Parameters<typeof octokitGraphql>
): Promise<ResponseData> {
  const token = getRequiredEnvironmentVariable('GITHUB_AUTH_TOKEN');
  const authenticatedRequest = request.defaults({
    headers: {
      authorization: `Bearer ${token}`,
    },
  });
  const authenticatedGraphql = withCustomRequest(authenticatedRequest);
  return await authenticatedGraphql<ResponseData>(...args);
}
