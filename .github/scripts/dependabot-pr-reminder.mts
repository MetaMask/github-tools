export type PullRequest = {
  number: number;
  title: string;
  url: string;
  requestedTeams: string[];
  hasApproval: boolean;
  ciFailing: boolean;
};

export type Reminder = {
  byTeam: Record<string, PullRequest[]>;
  fallback: {
    failingCi: PullRequest[];
    readyToMerge: PullRequest[];
    needsOwner: PullRequest[];
  };
};

/**
 * Normalizes a team reference to a bare lowercase slug.
 *
 * @param team - The team, e.g. `@MetaMask/Core-Platform`.
 * @returns The slug, e.g. `core-platform`.
 */
export function normalizeTeam(team: string): string {
  return team
    .trim()
    .toLowerCase()
    .replace(/^@/u, '')
    .replace(/^metamask\//u, '');
}

/**
 * Sorts pull requests into per-team groups and fallback buckets.
 *
 * Failing CI goes to the fallback bucket first, then PRs with remaining
 * requested teams are grouped by team, then approved PRs are ready to merge,
 * and anything else needs an owner.
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
  const ownerTeams = options.ownerTeams?.map(normalizeTeam);
  const reminder: Reminder = {
    byTeam: {},
    fallback: { failingCi: [], readyToMerge: [], needsOwner: [] },
  };

  for (const pullRequest of pullRequests) {
    if (pullRequest.ciFailing) {
      reminder.fallback.failingCi.push(pullRequest);
      continue;
    }

    const teams = pullRequest.requestedTeams
      .map(normalizeTeam)
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
