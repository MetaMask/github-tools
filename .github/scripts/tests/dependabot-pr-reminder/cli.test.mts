import { execFile } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
   * @returns What it printed on stderr.
   */
  async function runWithoutSettings(scriptPath: string): Promise<string> {
    try {
      await execFileAsync(process.execPath, [scriptPath], {
        env: { PATH: process.env.PATH ?? '' },
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
    const dotted = join(
      SCRIPT,
      '..',
      '..',
      'dependabot-pr-reminder',
      'cli.mts',
    );
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
});
