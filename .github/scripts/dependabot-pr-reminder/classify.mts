import { normalizeTeamSlug } from '../shared/topology.mts';
import type { PullRequest, Reminder } from './types.mts';

/** A PR requested from more than this many teams goes to the fallback team. */
export const DEFAULT_SHARED_TEAM_THRESHOLD = 3;

/**
 * Sorts pull requests into per-team groups and fallback buckets.
 *
 * PRs with remaining requested teams are grouped by team. When more than
 * `sharedTeamThreshold` teams remain, no single team owns the PR, so it goes to
 * the fallback team instead. PRs with no team left are ready to merge when
 * approved, and otherwise need an owner.
 *
 * @param pullRequests - The open Dependabot pull requests.
 * @param options - Classification options.
 * @param options.ownerTeams - If set, only these teams are kept as owners.
 * @param options.fallbackTeam - The team that handles the fallback buckets.
 * @param options.sharedTeamThreshold - The most teams a PR can have and still
 * be listed under each of them. Defaults to 3.
 * @returns The classified reminder.
 */
export function classifyPullRequests(
  pullRequests: PullRequest[],
  options: {
    ownerTeams?: string[];
    fallbackTeam: string;
    sharedTeamThreshold?: number;
  },
): Reminder {
  const ownerTeams = options.ownerTeams?.map(normalizeTeamSlug);
  const sharedTeamThreshold =
    options.sharedTeamThreshold ?? DEFAULT_SHARED_TEAM_THRESHOLD;
  const reminder: Reminder = {
    byTeam: {},
    fallback: { sharedByManyTeams: [], readyToMerge: [], needsOwner: [] },
  };

  for (const pullRequest of pullRequests) {
    const teams = pullRequest.requestedTeams
      .map(normalizeTeamSlug)
      .filter((team) => !ownerTeams || ownerTeams.includes(team));

    const uniqueTeams = new Set(teams);

    if (uniqueTeams.size > sharedTeamThreshold) {
      reminder.fallback.sharedByManyTeams.push(pullRequest);
    } else if (uniqueTeams.size > 0) {
      for (const team of uniqueTeams) {
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
