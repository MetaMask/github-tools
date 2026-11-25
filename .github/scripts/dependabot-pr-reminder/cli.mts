import { realpathSync } from 'node:fs';
import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchTopology } from '../shared/topology.mts';
import type { Topology } from '../shared/topology.mts';
import { classifyPullRequests } from './classify.mts';
import { fetchDependabotPullRequests } from './github-api.mts';
import { parseGuideUrl, resolveReminderNote } from './reminder-note.mts';
import { buildSlackPayload } from './slack-payload.mts';
import { parseOwnerTeams, parseSharedTeamThreshold } from './teams.mts';

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
  // The name goes into a search query, so only allow plain owner/name values.
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository)) {
    throw new Error('GITHUB_REPOSITORY must be in owner/name form');
  }
  const ref = environment.TOPOLOGY_REF?.trim()
    ? environment.TOPOLOGY_REF.trim()
    : 'main';

  const pullRequests = await fetchDependabotPullRequests(repository, {
    environment,
  });
  // Skip the topology request entirely when there is nothing to report.
  if (pullRequests.length === 0) {
    console.log('No open Dependabot pull requests to report.');
    await appendFile(outputPath, 'has-prs=false\n');
    return;
  }

  const ownerTeams = parseOwnerTeams(environment.OWNER_TEAMS);
  const sharedTeamThreshold = parseSharedTeamThreshold(
    environment.SHARED_TEAM_THRESHOLD,
  );
  const reminder = classifyPullRequests(pullRequests, {
    ...(ownerTeams ? { ownerTeams } : {}),
    ...(sharedTeamThreshold === undefined ? {} : { sharedTeamThreshold }),
    fallbackTeam,
  });

  // Tags are a nicety. If topology is unavailable, still post, with team names
  // as plain text.
  let topology: Topology = {};
  try {
    topology = await fetchTopology({
      ref,
      gh: { environment, token: planningToken },
    });
  } catch (error) {
    console.log(
      `::warning::Could not read topology.json, posting without Slack tags: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const note = resolveReminderNote(
    environment.REMINDER_NOTE,
    repository,
    parseGuideUrl(environment.GUIDE_URL),
  );
  const payload = buildSlackPayload(reminder, topology, {
    fallbackTeam,
    repository,
    ...(note ? { note } : {}),
  });
  if (!payload) {
    console.log('No open Dependabot pull requests to report.');
    await appendFile(outputPath, 'has-prs=false\n');
    return;
  }

  const payloadPath = join(
    environment.RUNNER_TEMP ?? '.',
    'dependabot-reminder-payload.json',
  );
  await writeFile(payloadPath, JSON.stringify(payload));
  await appendFile(outputPath, `has-prs=true\npayload-path=${payloadPath}\n`);
  console.log(`Wrote Slack payload with ${payload.blocks.length} sections.`);
}

// Compare real paths, since a symlinked directory makes the two differ and the
// script would otherwise silently do nothing.
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  main(process.env).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
