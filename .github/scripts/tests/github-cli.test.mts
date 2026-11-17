import { describe, expect, it, vi } from 'vitest';

import {
  ghApi,
  ghGraphql,
  ghGraphqlPages,
  isTransientGhError,
} from '../shared/github-cli.mts';

describe('isTransientGhError', () => {
  it.each([
    'gh: HTTP 429 Too Many Requests',
    'gh: HTTP 502 Bad Gateway',
    'gh: API rate limit exceeded for user',
    'read ECONNRESET',
  ])('retries %s', (message) => {
    expect(isTransientGhError(new Error(message))).toBe(true);
  });

  it.each([
    'gh: Not Found (HTTP 404)',
    'gh: Bad credentials (HTTP 401)',
    'gh: Resource not accessible by integration (HTTP 403)',
  ])('does not retry %s', (message) => {
    expect(isTransientGhError(new Error(message))).toBe(false);
  });

  it('reads stderr from the error', () => {
    const error = Object.assign(new Error('Command failed'), {
      stderr: 'gh: HTTP 503 Service Unavailable',
    });
    expect(isTransientGhError(error)).toBe(true);
  });
});

describe('ghApi', () => {
  const sleep = async (): Promise<void> => undefined;

  it('passes the token as GH_TOKEN without touching the base environment', async () => {
    const run = vi.fn<() => Promise<string>>().mockResolvedValue('out');
    const environment = { GH_TOKEN: 'default', PATH: '/bin' };
    const result = await ghApi(['repos/a/b'], {
      token: 'other',
      environment,
      run,
      sleep,
    });
    expect(result).toBe('out');
    expect(run).toHaveBeenCalledWith(['repos/a/b'], {
      GH_TOKEN: 'other',
      PATH: '/bin',
    });
    expect(environment.GH_TOKEN).toBe('default');
  });

  it('retries a transient failure', async () => {
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('gh: HTTP 502'))
      .mockResolvedValue('ok');
    expect(await ghApi(['x'], { environment: {}, run, sleep })).toBe('ok');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 404', async () => {
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new Error('gh: Not Found (HTTP 404)'));
    await expect(ghApi(['x'], { environment: {}, run, sleep })).rejects.toThrow(
      '404',
    );
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('ghGraphql', () => {
  const sleep = async (): Promise<void> => undefined;

  it('sends the query and variables and parses one response', async () => {
    const run = vi
      .fn<() => Promise<string>>()
      .mockResolvedValue('{"data":{"a":1}}');
    const result = await ghGraphql<{ data: { a: number } }>(
      'query { a }',
      { owner: 'o' },
      { environment: {}, run, sleep },
    );
    expect(result).toStrictEqual({ data: { a: 1 } });
    expect(run).toHaveBeenCalledWith(
      ['graphql', '-f', 'query=query { a }', '-f', 'owner=o'],
      expect.anything(),
    );
  });

  it('pages with --paginate --slurp', async () => {
    const run = vi.fn<() => Promise<string>>().mockResolvedValue('[{},{}]');
    const pages = await ghGraphqlPages(
      'query { a }',
      {},
      { environment: {}, run, sleep },
    );
    expect(pages).toHaveLength(2);
    expect(run).toHaveBeenCalledWith(
      ['graphql', '--paginate', '--slurp', '-f', 'query=query { a }'],
      expect.anything(),
    );
  });
});
