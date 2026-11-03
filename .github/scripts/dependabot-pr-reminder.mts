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

export type Topology = Record<
  string,
  { githubHandle?: string; slackHandle?: { team?: string } }
>;

/**
 * Escapes characters that Slack mrkdwn treats as control characters.
 *
 * @param text - The raw text.
 * @returns The escaped text.
 */
function escapeSlack(text: string): string {
  return text
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;');
}

/**
 * Formats pull requests as bulleted Slack links.
 *
 * @param pullRequests - The pull requests to list.
 * @returns The bulleted lines.
 */
function formatPullRequests(pullRequests: PullRequest[]): string {
  return pullRequests
    .map(
      ({ url, number, title }) => `• <${url}|#${number} ${escapeSlack(title)}>`,
    )
    .join('\n');
}

/**
 * Builds the Slack incoming webhook payload for a reminder.
 *
 * @param reminder - The classified reminder.
 * @param topology - The team topology used to look up Slack user groups.
 * @param options - Payload options.
 * @param options.fallbackTeam - The team tagged on the fallback sections.
 * @param options.repository - The repository name shown in the header.
 * @returns The payload, or undefined when there is nothing to post.
 */
export function buildSlackPayload(
  reminder: Reminder,
  topology: Topology,
  options: { fallbackTeam: string; repository: string },
):
  | {
      text: string;
      // eslint-disable-next-line @typescript-eslint/naming-convention
      link_names: boolean;
      blocks: { type: string; text: { type: string; text: string } }[];
    }
  | undefined {
  const teamEntries = Object.entries(reminder.byTeam).filter(
    ([, pullRequests]) => pullRequests.length > 0,
  );
  const fallbackSections = [
    { label: 'Failing CI', pullRequests: reminder.fallback.failingCi },
    { label: 'Ready to merge', pullRequests: reminder.fallback.readyToMerge },
    { label: 'Needs owner', pullRequests: reminder.fallback.needsOwner },
  ].filter(({ pullRequests }) => pullRequests.length > 0);

  if (teamEntries.length === 0 && fallbackSections.length === 0) {
    return undefined;
  }

  const tag = (team: string): string => {
    const slug = normalizeTeam(team);
    const entry = Object.values(topology).find(
      ({ githubHandle }) =>
        githubHandle && normalizeTeam(githubHandle) === slug,
    );
    const id = entry?.slackHandle?.team;
    return id ? `<!subteam^${id}>` : slug;
  };

  const section = (text: string) => ({
    type: 'section',
    text: { type: 'mrkdwn', text },
  });

  const headline = `*[${escapeSlack(options.repository)}] Open Dependabot pull requests*`;
  const blocks = [section(headline)];
  const mentions = new Set<string>();
  const mention = (team: string): string => {
    const value = tag(team);
    if (value.startsWith('<!subteam^')) {
      mentions.add(value);
    }
    return value;
  };
  for (const [team, pullRequests] of teamEntries) {
    blocks.push(
      section(`${mention(team)}\n${formatPullRequests(pullRequests)}`),
    );
  }
  for (const { label, pullRequests } of fallbackSections) {
    blocks.push(
      section(
        `${mention(options.fallbackTeam)} *${label}*\n${formatPullRequests(pullRequests)}`,
      ),
    );
  }

  return {
    text: [headline, ...mentions].join(' '),
    // eslint-disable-next-line @typescript-eslint/naming-convention
    link_names: true,
    blocks,
  };
}
