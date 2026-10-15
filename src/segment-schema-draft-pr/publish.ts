import type { Octokit } from '@octokit/rest';
import fs from 'fs/promises';
import path from 'path';

import { botBranchName } from './config';
import { MAX_CHANGED_TS_FILES } from './constants';
import { emptySummary } from './generate';
import {
  closeSchemaPr,
  createOctokitClients,
  createSchemaPr,
  findOpenSchemaPr,
  loadPrTemplate,
  parseRepo,
  postComment,
  resolveClientPr,
  updateProposalCommentIfExists,
  updateSchemaPrBody,
  upsertProposalComment,
} from './github-api';
import type { CliArgs } from './parse-args';
import {
  renderClosedSchemaComment,
  renderCreatedComment,
  renderDraftOpenComment,
  renderGeneratedSchemaBlock,
  renderListedOnlyComment,
  renderNoLongerNeededComment,
  renderProposalComment,
  renderStaleComment,
  renderTooManyFilesComment,
  renderTooManyFilesStaleComment,
  renderUpdatedComment,
  renderWindowClosedComment,
  spliceSchemaPrBody,
} from './pr-body';
import type { GenerateSummary, SchemaPr } from './types';

/**
 * Octokit-only phase: comments and schema PR create/update/close.
 *
 * @param args - CLI args.
 */
export async function runPublish(args: CliArgs): Promise<void> {
  if (args.dryRun) {
    console.log('dry-run: skip GitHub writes');
    return;
  }

  const clientRepo = parseRepo(args.clientRepository);
  const schemaRepo = parseRepo(args.segmentSchemaRepository);
  const { client, schema } = createOctokitClients(
    args.githubToken,
    args.segmentSchemaToken,
  );
  const branch = botBranchName(args.platform, args.prNumber);

  if (args.mode === 'close') {
    const pr = await resolveClientPr(
      client,
      clientRepo,
      args.prNumber,
      args.clientRepository,
    );
    const schemaPr = await findOpenSchemaPr(schema, schemaRepo, branch);
    if (schemaPr && !pr.merged) {
      await postComment(
        schema,
        schemaRepo,
        schemaPr.number,
        renderClosedSchemaComment(),
      );
      await closeSchemaPr(schema, schemaRepo, schemaPr.number);
      await postComment(
        client,
        clientRepo,
        args.prNumber,
        renderWindowClosedComment(),
      );
    }
    return;
  }

  if (args.tooManyFiles) {
    await publishTooManyFiles({ args, client, schema });
    return;
  }

  const summary = args.noAnalyticsDiff
    ? emptySummary(branch)
    : await readSummary(args.schema);
  await publishGenerateResult({
    args,
    summary,
    client,
    schema,
  });
}

/**
 * Upserts the sticky comment when the PR exceeds the TypeScript file cap.
 *
 * @param params - Parsed CLI args and Octokit clients.
 * @param params.args - CLI args.
 * @param params.client - Client-repo Octokit.
 * @param params.schema - Schema-repo Octokit.
 */
export async function publishTooManyFiles(params: {
  args: CliArgs;
  client: Octokit;
  schema: Octokit;
}): Promise<void> {
  const { args, client, schema } = params;
  const clientRepo = parseRepo(args.clientRepository);
  const schemaRepo = parseRepo(args.segmentSchemaRepository);
  const branch = botBranchName(args.platform, args.prNumber);
  const existing = await findOpenSchemaPr(schema, schemaRepo, branch);
  const body = existing
    ? renderTooManyFilesStaleComment(existing, MAX_CHANGED_TS_FILES)
    : renderTooManyFilesComment(MAX_CHANGED_TS_FILES);
  await upsertProposalComment(client, clientRepo, args.prNumber, body);
}

/**
 * Posts proposal/status comments and creates or updates the schema PR.
 *
 * @param params - Parsed CLI args, generate summary, and Octokit clients.
 * @param params.args - CLI args.
 * @param params.summary - Generate summary from the schema working tree.
 * @param params.client - Client-repo Octokit.
 * @param params.schema - Schema-repo Octokit.
 */
export async function publishGenerateResult(params: {
  args: CliArgs;
  summary: GenerateSummary;
  client: Octokit;
  schema: Octokit;
}): Promise<void> {
  const { args, summary, client, schema } = params;
  const clientRepo = parseRepo(args.clientRepository);
  const schemaRepo = parseRepo(args.segmentSchemaRepository);
  const branch = botBranchName(args.platform, args.prNumber);
  const existing = await findOpenSchemaPr(schema, schemaRepo, branch);
  const clientPrUrl = `https://github.com/${args.clientRepository}/pull/${args.prNumber}`;

  if (args.mode === 'propose' && !existing) {
    if (!summary.hasChanges) {
      await updateProposalCommentIfExists(
        client,
        clientRepo,
        args.prNumber,
        renderNoLongerNeededComment(),
      );
      return;
    }
    await upsertProposalComment(
      client,
      clientRepo,
      args.prNumber,
      renderProposalComment(summary.changeset, summary.intendedFiles),
    );
    return;
  }

  if (args.mode === 'propose' && existing && !summary.hasChanges) {
    await upsertProposalComment(
      client,
      clientRepo,
      args.prNumber,
      renderStaleComment(existing),
    );
    return;
  }

  if (args.mode === 'create' && !args.pushed) {
    if (!summary.hasChanges) {
      await upsertProposalComment(
        client,
        clientRepo,
        args.prNumber,
        renderNoLongerNeededComment(),
      );
      return;
    }
    await upsertProposalComment(
      client,
      clientRepo,
      args.prNumber,
      renderListedOnlyComment(summary.changeset),
    );
    return;
  }

  if (!args.pushed && args.mode === 'propose' && existing) {
    const template = await loadPrTemplate(schema, schemaRepo);
    const generated = renderGeneratedSchemaBlock(
      clientPrUrl,
      summary.changeset,
      summary.intendedFiles,
    );
    const body = spliceSchemaPrBody(existing.body, template, generated);
    await updateSchemaPrBody(schema, schemaRepo, existing.number, body);
    await upsertProposalComment(
      client,
      clientRepo,
      args.prNumber,
      renderDraftOpenComment(existing),
    );
    return;
  }

  const template = await loadPrTemplate(schema, schemaRepo);
  const generated = renderGeneratedSchemaBlock(
    clientPrUrl,
    summary.changeset,
    summary.intendedFiles,
  );
  const title = `Draft schema for ${args.platform} PR #${args.prNumber}`;

  let schemaPr: SchemaPr;
  if (existing) {
    const body = spliceSchemaPrBody(existing.body, template, generated);
    await updateSchemaPrBody(schema, schemaRepo, existing.number, body);
    schemaPr = { ...existing, body };
    await postComment(
      client,
      clientRepo,
      args.prNumber,
      renderUpdatedComment(schemaPr),
    );
  } else {
    const body = spliceSchemaPrBody('', template, generated);
    schemaPr = await createSchemaPr(schema, schemaRepo, {
      branch,
      base: args.segmentSchemaBase,
      title,
      body,
    });
    await postComment(
      client,
      clientRepo,
      args.prNumber,
      renderCreatedComment(schemaPr),
    );
  }

  await upsertProposalComment(
    client,
    clientRepo,
    args.prNumber,
    renderDraftOpenComment(schemaPr),
  );
}

/**
 * Reads the generate summary written next to the schema checkout.
 *
 * @param schemaDir - Schema working tree.
 * @returns Parsed summary.
 */
async function readSummary(schemaDir: string): Promise<GenerateSummary> {
  const filePath = path.join(
    schemaDir,
    '.segment-schema-draft-pr-summary.json',
  );
  const text = await fs.readFile(filePath, 'utf8');
  return JSON.parse(text) as GenerateSummary;
}
