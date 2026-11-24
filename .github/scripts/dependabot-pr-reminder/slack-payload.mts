import {
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
      blocks: SlackBlock[];
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
  const entries: { block: SlackBlock; handle?: string | undefined }[] = [
    { block: section(headline) },
  ];
  const addSections = (
    header: { text: string; handle?: string },
    pullRequests: PullRequest[],
    label?: string,
  ): void => {
    const fullHeader = label ? `${header.text} *${label}*` : header.text;
    for (const text of chunkSections(
      fullHeader,
      formatPullRequestLines(pullRequests),
    )) {
      entries.push({ block: section(text), handle: header.handle });
    }
  };
  for (const [team, pullRequests] of teamEntries) {
    addSections(tag(team), pullRequests);
  }
  for (const { label, pullRequests } of fallbackSections) {
    addSections(tag(options.fallbackTeam), pullRequests, label);
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
  const mentions = new Set(
    shownEntries.flatMap(({ handle }) => (handle ? [handle] : [])),
  );

  return { text: [headline, ...mentions].join(' '), blocks };
}
