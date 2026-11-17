import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { retry } from './retry.mts';

const execFileAsync = promisify(execFile);

/** Options shared by the `gh api` helpers. */
export type GhOptions = {
  /** Token passed as `GH_TOKEN`, if different from the one in `environment`. */
  token?: string | undefined;
  /** The base environment for the child process. */
  environment: NodeJS.ProcessEnv;
  maxAttempts?: number;
  delayMilliseconds?: number;
  /** Runs `gh api`; replaced in tests. */
  run?: (
    argumentsList: string[],
    environment: NodeJS.ProcessEnv,
  ) => Promise<string>;
  /** Waits between attempts; replaced in tests. */
  sleep?: (milliseconds: number) => Promise<void>;
};

const MAX_BUFFER = 100 * 1024 * 1024;

const TRANSIENT_ERROR =
  /\bHTTP (?:429|500|502|503|504)\b|rate limit|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|ETIMEDOUT|socket hang up/iu;

/**
 * Reads the text of an error thrown by `gh`, including its stderr.
 *
 * @param error - The thrown value.
 * @returns The text to match against.
 */
function getErrorDetails(error: unknown): string {
  if (error instanceof Error) {
    const { stderr } = error as Error & { stderr?: unknown };
    return `${error.message}\n${typeof stderr === 'string' ? stderr : ''}`;
  }
  return String(error);
}

/**
 * Tells whether a `gh api` failure is worth retrying. Rate limits, 5xx
 * responses and network errors are. A 401, 403 without a rate limit, or 404
 * are not, since retrying cannot fix them and only burns more requests.
 *
 * @param error - The thrown value.
 * @returns True when the request may succeed on another attempt.
 */
export function isTransientGhError(error: unknown): boolean {
  return TRANSIENT_ERROR.test(getErrorDetails(error));
}

/**
 * Runs `gh api` for real.
 *
 * @param argumentsList - The arguments after `gh api`.
 * @param environment - The environment for the child process.
 * @returns The standard output.
 */
async function runGhApi(
  argumentsList: string[],
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const { stdout } = await execFileAsync('gh', ['api', ...argumentsList], {
    env: environment,
    maxBuffer: MAX_BUFFER,
  });
  return stdout;
}

/**
 * Runs `gh api`, retrying transient failures only.
 *
 * @param argumentsList - The arguments after `gh api`.
 * @param options - See {@link GhOptions}.
 * @returns The standard output.
 */
export async function ghApi(
  argumentsList: string[],
  options: GhOptions,
): Promise<string> {
  const {
    token,
    environment,
    maxAttempts = 3,
    delayMilliseconds = 2_000,
    run = runGhApi,
    sleep,
  } = options;
  const childEnvironment = token
    ? { ...environment, GH_TOKEN: token }
    : environment;
  return await retry(async () => await run(argumentsList, childEnvironment), {
    maxAttempts,
    delayMilliseconds,
    shouldRetry: isTransientGhError,
    sleep,
  });
}

/**
 * Builds the `gh api graphql` arguments for a query.
 *
 * @param query - The GraphQL query.
 * @param variables - String variables, passed with `-f`.
 * @param paginate - Whether to page with `--paginate --slurp`. The query must
 * then take `$endCursor` and select `pageInfo { hasNextPage endCursor }`.
 * @returns The arguments after `gh api`.
 */
function buildGraphqlArguments(
  query: string,
  variables: Record<string, string>,
  paginate: boolean,
): string[] {
  return [
    'graphql',
    ...(paginate ? ['--paginate', '--slurp'] : []),
    '-f',
    `query=${query}`,
    ...Object.entries(variables).flatMap(([key, value]) => [
      '-f',
      `${key}=${value}`,
    ]),
  ];
}

/**
 * Runs one GraphQL query.
 *
 * @param query - The GraphQL query.
 * @param variables - String variables.
 * @param options - See {@link GhOptions}.
 * @returns The parsed response.
 */
export async function ghGraphql<Response>(
  query: string,
  variables: Record<string, string>,
  options: GhOptions,
): Promise<Response> {
  const output = await ghApi(
    buildGraphqlArguments(query, variables, false),
    options,
  );
  return JSON.parse(output) as Response;
}

/**
 * Runs a paginated GraphQL query.
 *
 * @param query - The GraphQL query, taking `$endCursor`.
 * @param variables - String variables.
 * @param options - See {@link GhOptions}.
 * @returns One parsed response per page.
 */
export async function ghGraphqlPages<Response>(
  query: string,
  variables: Record<string, string>,
  options: GhOptions,
): Promise<Response[]> {
  const output = await ghApi(
    buildGraphqlArguments(query, variables, true),
    options,
  );
  return JSON.parse(output) as Response[];
}
