import { execFileSync } from 'node:child_process';

/**
 * Builds the environment for the throwaway repositories the tests create, so
 * the developer's global git config and any inherited `GIT_*` variables
 * cannot affect them. CI runners have no global git identity.
 *
 * @returns The environment.
 */
export function getGitTestEnvironment(): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
  );
  return {
    ...inherited,
    GIT_AUTHOR_NAME: 'Test User',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test User',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'commit.gpgsign',
    GIT_CONFIG_VALUE_0: 'false',
  };
}

/**
 * Runs Git in a directory with the isolated test environment.
 *
 * @param cwd - The directory to run in.
 * @param args - The Git arguments.
 * @returns The trimmed standard output.
 */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: getGitTestEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
