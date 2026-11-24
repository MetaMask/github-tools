import { escapeSlack } from '../shared/slack-blocks.mts';
import { CI_ICONS } from './slack-payload.mts';

/** The value of `reminder-note` that selects the built in note. */
export const DEFAULT_NOTE_KEYWORD = 'default';

/**
 * Builds the built in note, which tells teams what to do with the PRs. The icon
 * legend is built from the icons the message really uses.
 *
 * @param repository - The repository the PRs are in, such as `MetaMask/core`.
 * @returns The note, as Slack mrkdwn.
 */
function buildDefaultNote(repository: string): string {
  return [
    '*What to do if your team is tagged on a PR below*',
    `Some packages in ${escapeSlack(repository)} have outdated dependencies, and Dependabot opened PRs to bump them.`,
    '',
    '1. Read the changelogs of the dependencies being bumped.',
    `2. Check the icon: ${CI_ICONS.passing} CI passes, ${CI_ICONS.failing} CI fails, ${CI_ICONS.pending} CI is still running, ${CI_ICONS.unknown} no checks.`,
    '3. If CI fails, work out why and fix it. You can push directly to the PR, but Dependabot stops updating it once you do.',
    "4. Have a teammate review and approve it. If the PR touches other teams' packages, work with them to get their changes and approvals too.",
    '5. Merge once CI passes and every required team has approved.',
    '',
    'PRs under "Shared by many teams" are coordinated by the team tagged on that section.',
  ].join('\n');
}

/**
 * Works out the note to show from the `reminder-note` setting.
 *
 * @param value - The setting. Unset or `default` gives the built in note, empty
 * gives no note, and any other text is used as it is, with `{repository}`
 * replaced by the repository name.
 * @param repository - The repository the PRs are in.
 * @returns The note, or undefined when there should be none.
 */
export function resolveReminderNote(
  value: string | undefined,
  repository: string,
): string | undefined {
  if (value === undefined || value.trim() === DEFAULT_NOTE_KEYWORD) {
    return buildDefaultNote(repository);
  }
  const note = value.trim();
  return note
    ? note.replaceAll('{repository}', escapeSlack(repository))
    : undefined;
}
