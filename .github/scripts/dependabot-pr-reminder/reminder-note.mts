import { escapeSlack } from '../shared/slack-blocks.mts';

/** The value of `reminder-note` that selects the built in note. */
export const DEFAULT_NOTE_KEYWORD = 'default';

const DEFAULT_NOTE =
  ':wave: *Is your team tagged?* Check the changelogs, fix CI if it fails, and get approval from every tagged team before merging. Pushing to a PR yourself is fine, but Dependabot stops updating it after that.';

const GUIDE_URL_PATTERN = /^https:\/\/[^\s<>|]+$/u;

/**
 * Checks and returns the guide URL from the `guide-url` setting.
 *
 * @param value - The setting.
 * @returns The URL, or undefined when empty.
 * @throws If the value is not an https URL that is safe to put in a Slack link.
 */
export function parseGuideUrl(value: string | undefined): string | undefined {
  const trimmed = (value ?? '').trim();
  if (!trimmed) {
    return undefined;
  }
  if (!GUIDE_URL_PATTERN.test(trimmed)) {
    throw new Error('GUIDE_URL must be an https URL');
  }
  return trimmed;
}

/**
 * Works out the note to show from the `reminder-note` setting.
 *
 * @param value - The setting. Unset or `default` gives the built in note, empty
 * gives no note, and any other text is used as it is, with `{repository}`
 * replaced by the repository name.
 * @param repository - The repository the PRs are in.
 * @param guideUrl - A link to a guide, added under the note when there is one.
 * @returns The note, or undefined when there should be none.
 */
export function resolveReminderNote(
  value: string | undefined,
  repository: string,
  guideUrl?: string,
): string | undefined {
  const trimmed = value?.trim();
  const note =
    trimmed === undefined || trimmed === DEFAULT_NOTE_KEYWORD
      ? DEFAULT_NOTE
      : trimmed.replaceAll('{repository}', escapeSlack(repository));
  if (!note) {
    return undefined;
  }
  return guideUrl ? `${note}\n<${guideUrl}|Read the full guide>` : note;
}
