import type { PullRequest } from '../../dependabot-pr-reminder/types.mts';
import type { SlackBlock } from '../../shared/slack-blocks.mts';

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
    ...overrides,
  };
}

/**
 * Reads the text of a section block.
 *
 * @param block - The block, if any.
 * @returns The text, or an empty string when there is no block.
 */
export function sectionText(block: SlackBlock | undefined): string {
  return block?.text.text ?? '';
}
