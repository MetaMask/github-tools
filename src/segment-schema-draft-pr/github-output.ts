import { appendFileSync } from 'fs';

/**
 * Appends key=value lines to GITHUB_OUTPUT when running in Actions.
 *
 * @param githubOutput - Path from GITHUB_OUTPUT, if set.
 * @param entries - Output keys and values.
 */
export function writeGithubOutput(
  githubOutput: string | undefined,
  entries: readonly (readonly [string, string])[],
): void {
  const lines = entries.map(([key, value]) => `${key}=${value}`);
  for (const line of lines) {
    console.log(line);
  }
  if (!githubOutput) {
    return;
  }
  appendFileSync(githubOutput, `${lines.join('\n')}\n`);
}
