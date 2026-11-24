import {
  MAX_BLOCKS,
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

/** A small grey Slack block, used for the closing note. */
export type ContextBlock = {
  type: 'context';
  elements: { type: 'mrkdwn'; text: string }[];
};

/** Any block in the payload. */
export type ReminderBlock = SlackBlock | ContextBlock;

/** Long titles are cut before escaping so a cut can't split a link or entity. */
const MAX_TITLE_LENGTH = 200;

/**
 * Formats pull requests as bulleted Slack links, one line each.
 *
 * @param pullRequests - The pull requests to list.
 * @returns The bulleted lines.
 */
function formatPullRequestLines(pullRequests: PullRequest[]): string[] {
  return pullRequests.map(
    ({ url, number, title }) =>
      `• <${url}|#${number} ${escapeSlack(truncateText(title, MAX_TITLE_LENGTH))}>`,
  );
}

/**
 * Merges teams that have the same pull requests, so a PR requested from
 * several teams is listed once with all of them tagged. Groups keep the order
 * in which their first team appears.
 *
 * @param teamEntries - Each team with its pull requests.
 * @returns The groups of teams and the pull requests they share.
 */
function groupTeamsByPullRequests(
  teamEntries: [string, PullRequest[]][],
): { teams: string[]; pullRequests: PullRequest[] }[] {
  const groups = new Map<
    string,
    { teams: string[]; pullRequests: PullRequest[] }
  >();
  for (const [team, pullRequests] of teamEntries) {
    const key = pullRequests
      .map(({ number }) => number)
      .sort((left, right) => left - right)
      .join(',');
    const group = groups.get(key);
    if (group) {
      group.teams.push(team);
    } else {
      groups.set(key, { teams: [team], pullRequests });
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
 * @param options.note - Text shown in a closing note, as Slack mrkdwn. Left out
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
      blocks: ReminderBlock[];
    }
  | undefined {
  const teamEntries = Object.entries(reminder.byTeam).filter(
    ([, pullRequests]) => pullRequests.length > 0,
  );
  const teamGroups = groupTeamsByPullRequests(teamEntries);
  const fallbackSections = [
    { label: 'Failing CI', pullRequests: reminder.fallback.failingCi },
    { label: 'Ready to merge', pullRequests: reminder.fallback.readyToMerge },
    { label: 'Needs owner', pullRequests: reminder.fallback.needsOwner },
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
  const entries: { block: SlackBlock; handles: string[] }[] = [
    { block: section(headline), handles: [] },
  ];
  const addSections = (
    teams: string[],
    pullRequests: PullRequest[],
    label?: string,
  ): void => {
    const tags = teams.map(tag);
    const header = tags.map(({ text }) => text).join(' ');
    const fullHeader = label ? `${header} *${label}*` : header;
    const handles = tags.flatMap(({ handle }) => (handle ? [handle] : []));
    for (const text of chunkSections(
      fullHeader,
      formatPullRequestLines(pullRequests),
    )) {
      entries.push({ block: section(text), handles });
    }
  };
  for (const { teams, pullRequests } of teamGroups) {
    addSections(teams, pullRequests);
  }
  for (const { label, pullRequests } of fallbackSections) {
    addSections([options.fallbackTeam], pullRequests, label);
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
    // Keep a slot free for the closing note, so the cap can't cut it off.
    options.note ? MAX_BLOCKS - 1 : MAX_BLOCKS,
  );
  const shownEntries =
    omitted.length > 0 ? entries.slice(0, blocks.length - 1) : entries;
  const mentions = new Set(shownEntries.flatMap(({ handles }) => handles));

  const noteBlock: ContextBlock[] = options.note
    ? [
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: truncateText(options.note, MAX_SECTION_LENGTH),
            },
          ],
        },
      ]
    : [];

  return {
    text: [headline, ...mentions].join(' '),
    blocks: [...blocks, ...noteBlock],
  };
}
