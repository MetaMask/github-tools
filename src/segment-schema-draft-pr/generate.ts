import type { Octokit } from '@octokit/rest';
import fs from 'fs/promises';
import path from 'path';
import ts from 'typescript';

import {
  extractAnalyticsModel,
  extractEnumCatalog,
  mergeAnalyticsModels,
} from './analytics-model';
import { applyChanges } from './apply-changes';
import {
  getFileAtRef,
  hasAnalyticsDiff,
  loadPullRequestTsDiff,
} from './client-diff';
import { getPlatformConfig } from './config';
import {
  changesetHasContent,
  changesetHasWritableChanges,
  diffModels,
} from './diff-models';
import type { RepoId } from './github-api';
import { buildSchemaIndex } from './schema-index';
import type {
  AnalyticsModel,
  GenerateSummary,
  Platform,
  PlatformConfig,
} from './types';

/**
 * Generates schema YAML in the workspace from a client PR diff.
 *
 * @param params - Octokit client, SHAs, and platform.
 * @param params.octokit - Client-repo Octokit.
 * @param params.clientRepo - Mobile or Extension repo.
 * @param params.prNumber - Client pull request number.
 * @param params.schemaDir - Schema working tree to write.
 * @param params.previousDir - Previous bot-branch checkout, if any.
 * @param params.platform - Mobile or extension.
 * @param params.baseSha - Pull request base SHA.
 * @param params.headSha - Pull request head SHA.
 * @param params.branch - Bot branch name.
 * @param params.defaultLibrary - Optional unsorted library override.
 * @returns Summary for GITHUB_OUTPUT and publish.
 */
export async function generateSchemaDraft(params: {
  octokit: Octokit;
  clientRepo: RepoId;
  prNumber: number;
  schemaDir: string;
  previousDir: string | undefined;
  platform: Platform;
  baseSha: string;
  headSha: string;
  branch: string;
  defaultLibrary: string | undefined;
}): Promise<GenerateSummary> {
  const config = { ...getPlatformConfig(params.platform) };
  if (params.defaultLibrary) {
    config.defaultLibrary = params.defaultLibrary;
  }
  const { files: changed, mentionsAnalytics } = await loadPullRequestTsDiff(
    params.octokit,
    params.clientRepo,
    params.prNumber,
  );

  if (!hasAnalyticsDiff({ files: changed, mentionsAnalytics }, config)) {
    return emptySummary(params.branch);
  }

  const files = new Set(changed);
  files.add(config.catalogFile);

  const baseModel = await modelAtSha(
    params.octokit,
    params.clientRepo,
    params.baseSha,
    [...files],
    config,
  );
  const headModel = await modelAtSha(
    params.octokit,
    params.clientRepo,
    params.headSha,
    [...files],
    config,
  );

  const changeset = diffModels(baseModel, headModel);
  const hasChanges = changesetHasContent(changeset);

  if (!hasChanges || !changesetHasWritableChanges(changeset)) {
    return {
      hasChanges,
      branch: params.branch,
      changeset,
      intendedFiles: [],
      schemaPrNumber: null,
      schemaPrUrl: null,
    };
  }

  const index = await buildSchemaIndex(params.schemaDir);
  const applied = await applyChanges(
    params.schemaDir,
    params.previousDir,
    config,
    changeset,
    index,
  );

  return {
    hasChanges: true,
    branch: params.branch,
    changeset,
    intendedFiles: applied.intendedFiles,
    schemaPrNumber: null,
    schemaPrUrl: null,
  };
}

/**
 * Builds an analytics model from file contents at one SHA.
 *
 * @param octokit - Client-repo Octokit.
 * @param clientRepo - Mobile or Extension repo.
 * @param sha - Git SHA.
 * @param files - Paths to extract.
 * @param config - Platform config.
 * @returns Merged model.
 */
async function modelAtSha(
  octokit: Octokit,
  clientRepo: RepoId,
  sha: string,
  files: string[],
  config: PlatformConfig,
): Promise<AnalyticsModel> {
  const catalogText = await getFileAtRef(
    octokit,
    clientRepo,
    config.catalogFile,
    sha,
  );
  const sharedCatalog =
    catalogText === null
      ? undefined
      : extractEnumCatalog(
          ts.createSourceFile(
            config.catalogFile,
            catalogText,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS,
          ),
          config.enumName,
        );

  const models: AnalyticsModel[] = [];
  if (catalogText !== null) {
    models.push(
      extractAnalyticsModel(
        config.catalogFile,
        catalogText,
        config,
        sharedCatalog,
      ),
    );
  }
  for (const file of files) {
    if (file === config.catalogFile) {
      continue;
    }
    const text = await getFileAtRef(octokit, clientRepo, file, sha);
    if (text === null) {
      continue;
    }
    models.push(extractAnalyticsModel(file, text, config, sharedCatalog));
  }
  return mergeAnalyticsModels(models);
}

/**
 * Summary when the PR has no analytics-looking diff.
 *
 * @param branch - Bot branch name.
 * @returns Empty generate summary.
 */
export function emptySummary(branch: string): GenerateSummary {
  return {
    hasChanges: false,
    branch,
    changeset: {
      eventsAdded: [],
      eventsRemoved: [],
      eventsRenamed: [],
      propertiesAdded: [],
      propertiesRemoved: [],
      typeChanges: [],
      unresolved: [],
    },
    intendedFiles: [],
    schemaPrNumber: null,
    schemaPrUrl: null,
  };
}

/**
 * Writes the generate summary JSON next to the schema checkout.
 *
 * @param schemaDir - Schema working tree.
 * @param summary - Generate result.
 * @returns Absolute path of the summary file.
 */
export async function writeSummaryFile(
  schemaDir: string,
  summary: GenerateSummary,
): Promise<string> {
  const filePath = path.join(
    schemaDir,
    '.segment-schema-draft-pr-summary.json',
  );
  await fs.writeFile(filePath, JSON.stringify(summary, replacer, 2));
  return filePath;
}

/**
 * JSON replacer that serializes Maps.
 *
 * @param _key - JSON key.
 * @param value - Value.
 * @returns JSON-safe value.
 */
function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Map) {
    return Object.fromEntries(value);
  }
  return value;
}
