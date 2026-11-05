import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyPullRequests } from './classify.mts';
import {
  PULL_REQUESTS_QUERY,
  buildTopologyPath,
  collectRequestedTeams,
  ghApi,
  toPullRequest,
} from './github-api.mts';
import type { GraphQlPullRequestNode } from './github-api.mts';
import { buildSlackPayload } from './slack-payload.mts';
import { parseOwnerTeams } from './teams.mts';
import type { PullRequest, Topology } from './types.mts';

/**
 * Fetches open Dependabot pull requests and writes the Slack payload.
 *
 * @param environment - The process environment.
 */
export async function main(environment: NodeJS.ProcessEnv): Promise<void> {
  const repository = environment.GITHUB_REPOSITORY;
  const fallbackTeam = environment.FALLBACK_TEAM;
  const planningToken = environment.PLANNING_TOKEN;
  const outputPath = environment.GITHUB_OUTPUT;
  if (!repository || !fallbackTeam || !planningToken || !outputPath) {
    throw new Error(
      'GITHUB_REPOSITORY, FALLBACK_TEAM, PLANNING_TOKEN and GITHUB_OUTPUT are required',
    );
  }
  const [owner, name] = repository.split('/');
  if (!owner || !name) {
    throw new Error('GITHUB_REPOSITORY must be in owner/name form');
  }
  const ref = environment.TOPOLOGY_REF?.trim()
    ? environment.TOPOLOGY_REF.trim()
    : 'main';

  const graphqlOutput = await ghApi(
    [
      'graphql',
      '--paginate',
      '--slurp',
      '-f',
      `query=${PULL_REQUESTS_QUERY}`,
      '-f',
      `owner=${owner}`,
      '-f',
      `name=${name}`,
    ],
    undefined,
    environment,
  );
  const pages = JSON.parse(graphqlOutput) as {
    data: { repository: { pullRequests: { nodes: GraphQlPullRequestNode[] } } };
  }[];
  const restOutput = await ghApi(
    [
      '--paginate',
      '--slurp',
      `repos/${owner}/${name}/pulls?state=open&per_page=100`,
    ],
    undefined,
    environment,
  );
  const requestedTeamsByNumber = collectRequestedTeams(
    JSON.parse(restOutput) as Parameters<typeof collectRequestedTeams>[0],
  );
  const pullRequests = pages
    .flatMap((page) => page.data.repository.pullRequests.nodes)
    .map((node) =>
      toPullRequest(node, requestedTeamsByNumber.get(node.number) ?? []),
    )
    .filter((pullRequest): pullRequest is PullRequest => Boolean(pullRequest));

  const ownerTeams = parseOwnerTeams(environment.OWNER_TEAMS);
  const reminder = classifyPullRequests(pullRequests, {
    ...(ownerTeams ? { ownerTeams } : {}),
    fallbackTeam,
  });

  const topology = JSON.parse(
    await ghApi(
      ['-H', 'Accept: application/vnd.github.raw', buildTopologyPath(ref)],
      planningToken,
      environment,
    ),
  ) as Topology;

  const payload = buildSlackPayload(reminder, topology, {
    fallbackTeam,
    repository,
  });

  if (!payload) {
    console.log('No open Dependabot pull requests to report.');
    appendFileSync(outputPath, 'has-prs=false\n');
    return;
  }

  const payloadPath = join(
    environment.RUNNER_TEMP ?? '.',
    'dependabot-reminder-payload.json',
  );
  writeFileSync(payloadPath, JSON.stringify(payload));
  appendFileSync(outputPath, `has-prs=true\npayload-path=${payloadPath}\n`);
  console.log(`Wrote Slack payload with ${payload.blocks.length} sections.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.env).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
