import type { PullRequest } from '../../dependabot-pr-reminder/types.mts';

/**
 * Builds a pull request for tests.
 *
 * @param overrides - Fields to override on the default pull request.
 * @returns The pull request.
 */
export function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 1,
    title: 'Bump foo from 1.0.0 to 1.0.1',
    url: 'https://github.com/MetaMask/example/pull/1',
    requestedTeams: [],
    hasApproval: false,
    ciFailing: false,
    ...overrides,
  };
}
