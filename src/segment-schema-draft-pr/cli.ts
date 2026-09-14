import { botBranchName } from './config';
import { changesetHasWritableChanges } from './diff-models';
import { generateSchemaDraft, writeSummaryFile } from './generate';
import { createOctokitClients, parseRepo } from './github-api';
import { writeGithubOutput } from './github-output';
import { parseCliArgs, type CliArgs } from './parse-args';
import { runPublish } from './publish';
import { getProcessEnv } from '../env-utils';

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});

/**
 * CLI entry for generate / publish phases.
 */
async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2), getProcessEnv());

  if (args.phase === 'generate') {
    await runGenerate(args);
    return;
  }
  if (args.phase === 'publish') {
    await runPublish(args);
  }
}

/**
 * Writes YAML into the schema working tree from the client PR file list.
 *
 * @param args - CLI args.
 */
async function runGenerate(args: CliArgs): Promise<void> {
  const previousDir =
    args.previousDir && args.previousDir !== 'true'
      ? args.previousDir
      : undefined;
  const clientRepo = parseRepo(args.clientRepository);
  const { client } = createOctokitClients(
    args.githubToken,
    args.segmentSchemaToken,
  );

  const summary = await generateSchemaDraft({
    octokit: client,
    clientRepo,
    prNumber: args.prNumber,
    schemaDir: args.schema,
    previousDir,
    platform: args.platform,
    baseSha: args.baseSha,
    headSha: args.headSha,
    branch: botBranchName(args.platform, args.prNumber),
    defaultLibrary: args.defaultLibrary,
  });

  const summaryFile = await writeSummaryFile(args.schema, summary);

  writeGithubOutput(args.githubOutput, [
    ['has_changes', summary.hasChanges ? 'true' : 'false'],
    [
      'has_writable_changes',
      changesetHasWritableChanges(summary.changeset) ? 'true' : 'false',
    ],
    ['branch', summary.branch],
    ['summary_file', summaryFile],
  ]);
}
