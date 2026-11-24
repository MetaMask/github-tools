import { normalizeTeamSlug } from '../shared/topology.mts';
import type { PullRequest, Reminder } from './types.mts';

/**
 * Sorts pull requests into per-team groups and fallback buckets.
 *
 * PRs with remaining requested teams are grouped by team, whatever their CI
 * state, since the owning team is the one that fixes it. PRs with no team left
 * are ready to merge when approved, and otherwise need an owner.
 *
 * @param pullRequests - The open Dependabot pull requests.
 * @param options - Classification options.
 * @param options.ownerTeams - If set, only these teams are kept as owners.
 * @param options.fallbackTeam - The team that handles the fallback buckets.
 * @returns The classified reminder.
 */
export function classifyPullRequests(
  pullRequests: PullRequest[],
  options: { ownerTeams?: string[]; fallbackTeam: string },
): Reminder {
  const ownerTeams = options.ownerTeams?.map(normalizeTeamSlug);
  const reminder: Reminder = {
    byTeam: {},
    fallback: { readyToMerge: [], needsOwner: [] },
  };

  for (const pullRequest of pullRequests) {
    const teams = pullRequest.requestedTeams
      .map(normalizeTeamSlug)
      .filter((team) => !ownerTeams || ownerTeams.includes(team));

    if (teams.length > 0) {
      for (const team of new Set(teams)) {
        (reminder.byTeam[team] ??= []).push(pullRequest);
      }
    } else if (pullRequest.hasApproval) {
      reminder.fallback.readyToMerge.push(pullRequest);
    } else {
      reminder.fallback.needsOwner.push(pullRequest);
    }
  }

  return reminder;
}
