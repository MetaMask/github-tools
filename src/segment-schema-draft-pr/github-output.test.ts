import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { writeGithubOutput } from './github-output';

describe('writeGithubOutput', () => {
  it('appends key=value lines to the output file', async () => {
    const outputFile = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), 'gh-out-')),
      'output',
    );
    writeGithubOutput(outputFile, [
      ['has_changes', 'true'],
      ['branch', 'metamaskbot/mobile-pr-1'],
    ]);
    const text = await fs.readFile(outputFile, 'utf8');
    expect(text).toBe('has_changes=true\nbranch=metamaskbot/mobile-pr-1\n');
    await fs.rm(path.dirname(outputFile), { recursive: true, force: true });
  });

  it('prints lines when GITHUB_OUTPUT is unset', () => {
    const log = jest.spyOn(console, 'log').mockImplementation();
    writeGithubOutput(undefined, [['skip', 'true']]);
    expect(log).toHaveBeenCalledWith('skip=true');
    log.mockRestore();
  });
});
