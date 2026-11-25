import {
  MAX_BLOCKS,
  MAX_SECTION_LENGTH,
  escapeSlack,
  section,
  truncateText,
} from '../shared/slack-blocks.mts';
import type { SlackBlock } from '../shared/slack-blocks.mts';
import { getSlackHandle, normalizeTeamSlug } from '../shared/topology.mts';
import type { Topology } from '../shared/topology.mts';
import { describeUpdate } from './dependabot-title.mts';
import type { PullRequest, Reminder } from './types.mts';

export type HeaderBlock = {
  type: 'header';
  text: { type: 'plain_text'; text: string; emoji: true };
};
export type ContextBlock = {
  type: 'context';
  elements: { type: 'mrkdwn'; text: string }[];
};
export type DividerBlock = { type: 'divider' };

/** Any block in the payload. */
export type ReminderBlock =
  | SlackBlock
  | HeaderBlock
  | ContextBlock
  | DividerBlock;

/** Shown to tell a PR's CI state at a glance. */
export const CI_ICONS: Record<PullRequest['ciState'], string> = {
  passing: ':white_check_mark:',
  failing: ':x:',
  pending: ':hourglass_flowing_sand:',
  unknown: ':white_circle:',
};

const HEADER_TEXT = ':dependabot: Open Dependabot pull requests';

/** Long titles are cut before escaping so a cut can't split a link or entity. */
const MAX_TITLE_LENGTH = 200;

/** A block and the team mentions in it, so only shown teams get pinged. */
type Entry = { block: ReminderBlock; handles: string[] };

/** One pull request ready to show, with the mentions in its text. */
type Item = { text: string; handles: string[] };

const divider: DividerBlock = { type: 'divider' };

/**
 * Describes a pull request, as the package and versions when its title is a
 * Dependabot title we can read, and as the cut down title otherwise.
 *
 * @param pullRequest - The pull request.
 * @returns The description, as Slack mrkdwn.
 */
function describePullRequest(pullRequest: PullRequest): string {
  const { title } = pullRequest;
  return (
    describeUpdate(title) ?? escapeSlack(truncateText(title, MAX_TITLE_LENGTH))
  );
}

/**
 * Packs items into section blocks that fit Slack's limit. The heading is
 * repeated on every block, and items are separated by a blank line.
 *
 * @param heading - The heading shown on top of each block.
 * @param headingHandles - The mentions in the heading.
 * @param items - The items to list.
 * @returns One or more blocks.
 */
function packItems(
  heading: string,
  headingHandles: string[],
  items: Item[],
): Entry[] {
  const budget = Math.max(MAX_SECTION_LENGTH - heading.length - 1, 1);
  const entries: Entry[] = [];
  let current: Item[] = [];
  let length = 0;

  const flush = (): void => {
    if (current.length > 0) {
      entries.push({
        block: section(
          `${heading}\n${current.map(({ text }) => text).join('\n\n')}`,
        ),
        handles: [
          ...headingHandles,
          ...current.flatMap(({ handles }) => handles),
        ],
      });
      current = [];
      length = 0;
    }
  };

  for (const item of items) {
    const text = truncateText(item.text, budget);
    const added = text.length + (current.length > 0 ? 2 : 0);
    if (current.length > 0 && length + added > budget) {
      flush();
    }
    length += text.length + (current.length > 0 ? 2 : 0);
    current.push({ text, handles: item.handles });
  }
  flush();
  return entries;
}

/**
 * Builds the Slack incoming webhook payload for a reminder.
 *
 * The message has a headline with counts, an optional note, then the pull
 * requests in groups: the ones that need a fix, the ones still running, the
 * ones shared by many teams, and the ones that pass CI. Each pull request is
 * listed once, with all of its teams tagged under it.
 *
 * @param reminder - The classified reminder.
 * @param topology - The team topology used to look up Slack user groups.
 * @param options - Payload options.
 * @param options.fallbackTeam - The team that coordinates shared pull requests
 * and the ones with no team.
 * @param options.repository - The repository, in `owner/name` form.
 * @param options.note - Text shown under the counts, as Slack mrkdwn. Left out
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
  // A handle like `@core-platform-team` in message text becomes a mention. A
  // team without one is shown as a plain name.
  const tag = (team: string): { text: string; handle?: string } => {
    const handle = getSlackHandle(topology, team);
    return handle
      ? { text: handle, handle }
      : { text: escapeSlack(normalizeTeamSlug(team)) };
  };

  // List each PR once, with every team it was requested from.
  const owned = new Map<
    number,
    { pullRequest: PullRequest; teams: string[] }
  >();
  for (const [team, pullRequests] of Object.entries(reminder.byTeam)) {
    for (const pullRequest of pullRequests) {
      const entry = owned.get(pullRequest.number);
      if (entry) {
        entry.teams.push(team);
      } else {
        owned.set(pullRequest.number, { pullRequest, teams: [team] });
      }
    }
  }
  for (const pullRequest of reminder.fallback.noTeam) {
    owned.set(pullRequest.number, {
      pullRequest,
      teams: [options.fallbackTeam],
    });
  }
  const shared = reminder.fallback.sharedByManyTeams;

  const everyPullRequest = [
    ...[...owned.values()].map(({ pullRequest }) => pullRequest),
    ...shared,
  ];
  if (everyPullRequest.length === 0) {
    return undefined;
  }

  const ownedItem = (
    { pullRequest, teams }: { pullRequest: PullRequest; teams: string[] },
    withIcon: boolean,
  ): Item => {
    const tags = teams.map(tag);
    const icon = withIcon ? `${CI_ICONS[pullRequest.ciState]} ` : '';
    return {
      text: `${icon}<${pullRequest.url}|#${pullRequest.number}> ${describePullRequest(pullRequest)}\n${tags.map(({ text }) => text).join(' ')}`,
      handles: tags.flatMap(({ handle }) => (handle ? [handle] : [])),
    };
  };

  const ownedBy = (
    states: PullRequest['ciState'][],
  ): { pullRequest: PullRequest; teams: string[] }[] =>
    [...owned.values()].filter(({ pullRequest }) =>
      states.includes(pullRequest.ciState),
    );

  const fallbackTag = tag(options.fallbackTeam);
  const groups: Entry[][] = [
    packItems(
      `*${CI_ICONS.failing} Needs a fix*`,
      [],
      ownedBy(['failing']).map((entry) => ownedItem(entry, false)),
    ),
    packItems(
      `*${CI_ICONS.pending} In progress*`,
      [],
      ownedBy(['pending', 'unknown']).map((entry) => ownedItem(entry, true)),
    ),
    packItems(
      `*:busts_in_silhouette: Shared by many teams*\nCoordinated by ${fallbackTag.text}`,
      fallbackTag.handle ? [fallbackTag.handle] : [],
      shared.map((pullRequest) => ({
        text: `${CI_ICONS[pullRequest.ciState]} <${pullRequest.url}|#${pullRequest.number}> ${describePullRequest(pullRequest)} · ${pullRequest.requestedTeams.length} teams`,
        handles: [],
      })),
    ),
    packItems(
      `*${CI_ICONS.passing} CI passing*`,
      [],
      ownedBy(['passing']).map((entry) => ownedItem(entry, false)),
    ),
  ].filter((group) => group.length > 0);

  const middle: Entry[] = groups.flatMap((group, index) => [
    ...(index > 0 ? [{ block: divider, handles: [] }] : []),
    ...group,
  ]);

  // The counts line, only showing the states that have pull requests.
  const counts = (
    [
      ['passing', 'passing'],
      ['failing', 'failing'],
      ['pending', 'running'],
      ['unknown', 'no checks'],
    ] as const
  ).flatMap(([state, label]) => {
    const total = everyPullRequest.filter(
      ({ ciState }) => ciState === state,
    ).length;
    return total > 0 ? [`${CI_ICONS[state]} ${total} ${label}`] : [];
  });
  const repository = escapeSlack(options.repository);

  const top: ReminderBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: HEADER_TEXT, emoji: true },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: [
            `<https://github.com/${options.repository}|${repository}>`,
            `*${everyPullRequest.length}* open`,
            ...counts,
          ].join(' · '),
        },
      ],
    },
    ...(options.note
      ? [section(truncateText(options.note, MAX_SECTION_LENGTH))]
      : []),
    divider,
  ];
  const bottom: ReminderBlock[] = [
    divider,
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `${CI_ICONS.passing} CI passes · ${CI_ICONS.failing} CI fails · ${CI_ICONS.pending} CI running · ${CI_ICONS.unknown} no checks`,
        },
      ],
    },
  ];

  // Keep the top and bottom, and cut the middle if the message is too long.
  const room = MAX_BLOCKS - top.length - bottom.length;
  let shown = middle;
  let overflow: ReminderBlock[] = [];
  if (middle.length > room) {
    shown = middle.slice(0, room - 1);
    const omitted = middle.slice(room - 1);
    const omittedCount = omitted.reduce(
      (total, { block }) =>
        total +
        ('text' in block
          ? (block.text.text.match(/\|#\d+>/gu) ?? []).length
          : 0),
      0,
    );
    overflow = [section(`…and ${omittedCount} more pull request(s) not shown`)];
  }

  const mentions = new Set(shown.flatMap(({ handles }) => handles));
  return {
    text: [`Open Dependabot pull requests in ${repository}`, ...mentions].join(
      ' ',
    ),
    blocks: [
      ...top,
      ...shown.map(({ block }) => block),
      ...overflow,
      ...bottom,
    ],
  };
}
