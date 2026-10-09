import type { Mode, Phase, Platform } from './types';

export type CliArgs = {
  phase: Phase;
  mode: Mode;
  platform: Platform;
  schema: string;
  previousDir: string | undefined;
  baseSha: string;
  headSha: string;
  prNumber: number;
  clientRepository: string;
  segmentSchemaRepository: string;
  segmentSchemaBase: string;
  githubToken: string;
  segmentSchemaToken: string;
  dryRun: boolean;
  defaultLibrary: string | undefined;
  pushed: boolean;
  githubOutput: string | undefined;
  noAnalyticsDiff: boolean;
  tooManyFiles: boolean;
};

/**
 * Parses CLI flags used by the composite action.
 *
 * @param argv - Arguments after the node entrypoint.
 * @param env - Process environment map.
 * @returns Typed args.
 */
export function parseCliArgs(argv: string[], env: NodeJS.ProcessEnv): CliArgs {
  const raw = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token?.startsWith('--')) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      raw.set(key, 'true');
      continue;
    }
    raw.set(key, next);
    i += 1;
  }

  const phase = requireFlag(raw, 'phase') as Phase;
  const mode = requireFlag(raw, 'mode') as Mode;
  const platform = requireFlag(raw, 'platform') as Platform;

  return {
    phase,
    mode,
    platform,
    schema: raw.get('schema') ?? '',
    previousDir: raw.get('previous-dir'),
    baseSha: raw.get('base-sha') ?? '',
    headSha: raw.get('head-sha') ?? '',
    prNumber: Number(raw.get('pr-number') ?? env.PR_NUMBER ?? '0'),
    clientRepository:
      raw.get('client-repository') ?? env.GITHUB_REPOSITORY ?? '',
    segmentSchemaRepository:
      raw.get('segment-schema-repository') ?? 'Consensys/segment-schema',
    segmentSchemaBase: raw.get('segment-schema-base') ?? 'main',
    githubToken: env.GITHUB_TOKEN ?? '',
    segmentSchemaToken: env.SEGMENT_SCHEMA_TOKEN ?? '',
    dryRun: raw.get('dry-run') === 'true',
    defaultLibrary: raw.get('default-library'),
    pushed: raw.get('pushed') === 'true',
    githubOutput: env.GITHUB_OUTPUT,
    noAnalyticsDiff: raw.get('no-analytics-diff') === 'true',
    tooManyFiles: raw.get('too-many-files') === 'true',
  };
}

/**
 * Requires a flag to be present.
 *
 * @param raw - Parsed flag map.
 * @param name - Flag name.
 * @returns Value.
 */
function requireFlag(raw: Map<string, string>, name: string): string {
  const value = raw.get(name);
  if (!value) {
    throw new Error(`Missing --${name}`);
  }
  return value;
}
