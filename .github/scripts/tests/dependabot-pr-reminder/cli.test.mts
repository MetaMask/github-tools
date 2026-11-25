import { execFile } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const SCRIPT = fileURLToPath(
  new URL('../../dependabot-pr-reminder/cli.mts', import.meta.url),
);

describe('cli entry point', () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory) {
      await rm(directory, { recursive: true, force: true });
      directory = undefined;
    }
  });

  /**
   * Runs the script with no settings, so it stops at once with a message.
   *
   * @param scriptPath - The path to run it through.
   * @param settings - Environment settings to give it.
   * @returns What it printed on stderr.
   */
  async function runWithoutSettings(
    scriptPath: string,
    settings: Record<string, string> = {},
  ): Promise<string> {
    try {
      await execFileAsync(process.execPath, [scriptPath], {
        env: { PATH: process.env.PATH ?? '', ...settings },
      });
    } catch (error) {
      return (error as { stderr?: string }).stderr ?? '';
    }
    return '';
  }

  it('runs when started by its plain path', async () => {
    expect(await runWithoutSettings(SCRIPT)).toContain('are required');
  });

  it('runs when started through a path with .. segments', async () => {
    // Built as a string, since `path.join` would remove the `..` segments.
    const dotted = `${dirname(SCRIPT)}/../dependabot-pr-reminder/cli.mts`;
    expect(dotted).toContain('/../');
    expect(await runWithoutSettings(dotted)).toContain('are required');
  });

  it('runs when started through a symlinked directory', async () => {
    directory = await mkdtemp(join(tmpdir(), 'reminder-cli-'));
    const link = join(directory, 'scripts');
    await symlink(resolve(SCRIPT, '..'), link);
    expect(await runWithoutSettings(join(link, 'cli.mts'))).toContain(
      'are required',
    );
  });

  it.each(['MetaMask/core is:issue', 'MetaMask', 'a/b/c', 'a/b c'])(
    'rejects the repository %j before searching',
    async (repository) => {
      const output = await runWithoutSettings(SCRIPT, {
        GITHUB_REPOSITORY: repository,
        FALLBACK_TEAM: 'core-platform',
        PLANNING_TOKEN: 'token',
        GITHUB_OUTPUT: join(tmpdir(), 'reminder-cli-output.txt'),
      });
      expect(output).toContain('owner/name');
    },
  );
});
