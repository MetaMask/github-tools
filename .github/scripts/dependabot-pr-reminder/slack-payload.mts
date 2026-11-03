import { normalizeTeam } from './teams.mts';
import type { PullRequest, Reminder, Topology } from './types.mts';

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
 * The maximum characters of a section text we emit. Slack rejects 3000+.
 */
const MAX_SECTION_LENGTH = 2800;

/**
 * Formats pull requests as bulleted Slack links, one line each.
 *
 * @param pullRequests - The pull requests to list.
 * @returns The bulleted lines.
 */
function formatPullRequestLines(pullRequests: PullRequest[]): string[] {
  return pullRequests.map(
    ({ url, number, title }) => `• <${url}|#${number} ${escapeSlack(title)}>`,
  );
}

/**
 * Splits a header and lines into section texts that fit Slack's limit. The
 * header is repeated on every section.
 *
 * @param header - The header line.
 * @param lines - The lines to list below the header.
 * @returns One or more section texts.
 */
function chunkSections(header: string, lines: string[]): string[] {
  const budget = Math.max(MAX_SECTION_LENGTH - header.length - 1, 1);
  const texts: string[] = [];
  let current: string[] = [];
  let length = 0;

  for (const rawLine of lines) {
    const line =
      rawLine.length > budget ? `${rawLine.slice(0, budget - 1)}…` : rawLine;
    const added = line.length + (current.length > 0 ? 1 : 0);
    if (current.length > 0 && length + added > budget) {
      texts.push(`${header}\n${current.join('\n')}`);
      current = [];
      length = 0;
    }
    length += line.length + (current.length > 0 ? 1 : 0);
    current.push(line);
  }
  if (current.length > 0) {
    texts.push(`${header}\n${current.join('\n')}`);
  }
  return texts;
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
      (candidate) =>
        typeof candidate?.githubHandle === 'string' &&
        normalizeTeam(candidate.githubHandle) === slug,
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
    for (const text of chunkSections(
      mention(team),
      formatPullRequestLines(pullRequests),
    )) {
      blocks.push(section(text));
    }
  }
  for (const { label, pullRequests } of fallbackSections) {
    for (const text of chunkSections(
      `${mention(options.fallbackTeam)} *${label}*`,
      formatPullRequestLines(pullRequests),
    )) {
      blocks.push(section(text));
    }
  }

  const maxBlocks = 50;
  if (blocks.length > maxBlocks) {
    const omitted = blocks.splice(maxBlocks - 1);
    const omittedCount = omitted.reduce(
      (total, block) =>
        total +
        block.text.text.split('\n').filter((line) => line.startsWith('•'))
          .length,
      0,
    );
    blocks.push(section(`…and ${omittedCount} more pull request(s) not shown`));
  }

  return {
    text: [headline, ...mentions].join(' '),
    // eslint-disable-next-line @typescript-eslint/naming-convention
    link_names: true,
    blocks,
  };
}
