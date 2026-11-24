import {
  MAX_SECTION_LENGTH,
  capBlocks,
  chunkSections,
  escapeSlack,
  section,
  truncateText,
} from '../shared/slack-blocks.mts';
import type { SlackBlock } from '../shared/slack-blocks.mts';
import { getSlackHandle, normalizeTeamSlug } from '../shared/topology.mts';
import type { Topology } from '../shared/topology.mts';
import type { PullRequest, Reminder } from './types.mts';

/** Long titles are cut before escaping so a cut can't split a link or entity. */
const MAX_TITLE_LENGTH = 200;

/** Shown in front of each PR to tell its CI state at a glance. */
export const CI_ICONS: Record<PullRequest['ciState'], string> = {
  passing: ':white_check_mark:',
  failing: ':warning:',
  pending: ':hourglass_flowing_sand:',
  unknown: ':white_circle:',
};

/**
 * Formats pull requests as bulleted Slack links, one line each.
 *
 * @param pullRequests - The pull requests to list.
 * @param showTeamCount - Whether to add how many teams were requested.
 * @returns The bulleted lines.
 */
function formatPullRequestLines(
  pullRequests: PullRequest[],
  showTeamCount: boolean,
): string[] {
  return pullRequests.map(
    ({ url, number, title, requestedTeams, ciState }) =>
      `• ${CI_ICONS[ciState]} <${url}|#${number} ${escapeSlack(truncateText(title, MAX_TITLE_LENGTH))}>${
        showTeamCount ? ` (${requestedTeams.length} teams)` : ''
      }`,
  );
}

/**
 * Groups pull requests by the teams they were requested from, so each PR is
 * listed once, under all of its teams. PRs with the same set of teams share a
 * group. Groups and teams keep the order in which they first appear.
 *
 * @param byTeam - Each team with its pull requests.
 * @returns The groups of teams and the pull requests they share.
 */
function groupPullRequestsByTeams(
  byTeam: Reminder['byTeam'],
): { teams: string[]; pullRequests: PullRequest[] }[] {
  const teamsByPullRequest = new Map<
    number,
    { pullRequest: PullRequest; teams: string[] }
  >();
  for (const [team, pullRequests] of Object.entries(byTeam)) {
    for (const pullRequest of pullRequests) {
      const entry = teamsByPullRequest.get(pullRequest.number);
      if (entry) {
        entry.teams.push(team);
      } else {
        teamsByPullRequest.set(pullRequest.number, {
          pullRequest,
          teams: [team],
        });
      }
    }
  }

  const groups = new Map<
    string,
    { teams: string[]; pullRequests: PullRequest[] }
  >();
  for (const { pullRequest, teams } of teamsByPullRequest.values()) {
    const key = [...teams].sort().join(',');
    const group = groups.get(key);
    if (group) {
      group.pullRequests.push(pullRequest);
    } else {
      groups.set(key, { teams, pullRequests: [pullRequest] });
    }
  }
  return [...groups.values()];
}

/**
 * Builds the Slack incoming webhook payload for a reminder.
 *
 * @param reminder - The classified reminder.
 * @param topology - The team topology used to look up Slack user groups.
 * @param options - Payload options.
 * @param options.fallbackTeam - The team tagged on the fallback sections.
 * @param options.repository - The repository name shown in the header.
 * @param options.note - Text shown right under the headline, as Slack mrkdwn. Left out
 * when empty.
 * @returns The payload, or undefined when there is nothing to post.
 */
export function buildSlackPayload(
  reminder: Reminder,
  topology: Topology,
  options: { fallbackTeam: string; repository: string; note?: string },
):
  | {
      text: string;
      blocks: SlackBlock[];
    }
  | undefined {
  const teamEntries = Object.entries(reminder.byTeam).filter(
    ([, pullRequests]) => pullRequests.length > 0,
  );
  const teamGroups = groupPullRequestsByTeams(reminder.byTeam);
  const fallbackSections = [
    {
      label: 'Shared by many teams',
      pullRequests: reminder.fallback.sharedByManyTeams,
      showTeamCount: true,
    },
    {
      label: undefined,
      pullRequests: reminder.fallback.noTeam,
      showTeamCount: false,
    },
  ].filter(({ pullRequests }) => pullRequests.length > 0);

  if (teamEntries.length === 0 && fallbackSections.length === 0) {
    return undefined;
  }

  // A handle like `@core-platform-team` in message text becomes a mention. A
  // team without one is shown as a plain name.
  const tag = (team: string): { text: string; handle?: string } => {
    const handle = getSlackHandle(topology, team);
    return handle
      ? { text: handle, handle }
      : { text: escapeSlack(normalizeTeamSlug(team)) };
  };

  const headline = `*[${escapeSlack(options.repository)}] Open Dependabot pull requests*`;
  // Each section remembers its team mention, so only teams whose section is
  // actually sent get pinged.
  // The note goes right under the headline. The block cap only cuts from the
  // end, so it is always shown.
  const entries: { block: SlackBlock; handles: string[] }[] = [
    { block: section(headline), handles: [] },
    ...(options.note
      ? [
          {
            block: section(truncateText(options.note, MAX_SECTION_LENGTH)),
            handles: [],
          },
        ]
      : []),
  ];
  const addSections = (
    teams: string[],
    pullRequests: PullRequest[],
    {
      label,
      showTeamCount = false,
    }: { label?: string | undefined; showTeamCount?: boolean } = {},
  ): void => {
    const tags = teams.map(tag);
    const header = tags.map(({ text }) => text).join(' ');
    const fullHeader = label ? `${header} *${label}*` : header;
    const handles = tags.flatMap(({ handle }) => (handle ? [handle] : []));
    for (const text of chunkSections(
      fullHeader,
      formatPullRequestLines(pullRequests, showTeamCount),
    )) {
      entries.push({ block: section(text), handles });
    }
  };
  for (const { teams, pullRequests } of teamGroups) {
    addSections(teams, pullRequests);
  }
  for (const { label, pullRequests, showTeamCount } of fallbackSections) {
    addSections([options.fallbackTeam], pullRequests, { label, showTeamCount });
  }

  const { blocks, omitted } = capBlocks(
    entries.map(({ block }) => block),
    (omittedBlocks) =>
      `…and ${omittedBlocks.reduce(
        (total, block) =>
          total +
          block.text.text.split('\n').filter((line) => line.startsWith('•'))
            .length,
        0,
      )} more pull request(s) not shown`,
  );
  const shownEntries =
    omitted.length > 0 ? entries.slice(0, blocks.length - 1) : entries;
  const mentions = new Set(shownEntries.flatMap(({ handles }) => handles));

  return {
    text: [headline, ...mentions].join(' '),
    blocks,
  };
}
