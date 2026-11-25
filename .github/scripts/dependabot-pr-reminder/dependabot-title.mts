import { escapeSlack } from '../shared/slack-blocks.mts';

// An optional conventional commit prefix, such as `chore(deps):`. The scope is
// captured so `deps-dev` can be told apart from `deps`.
const PREFIX = String.raw`(?:[a-z]+(?:\(([^)]*)\))?!?:\s*)?`;
const IN_DIRECTORY = String.raw`(?:\s+in\s+(\S+))?`;

const PACKAGE_TITLE = new RegExp(
  `^${PREFIX}[Bb]ump\\s+(\\S+)\\s+from\\s+(\\S+)\\s+to\\s+(\\S+?)${IN_DIRECTORY}$`,
  'u',
);

const GROUP_TITLE = new RegExp(
  `^${PREFIX}[Bb]ump\\s+the\\s+(\\S+)\\s+group(?:\\s+(?:across\\s+\\d+\\s+director(?:y|ies)|in\\s+\\S+))?\\s+with\\s+(\\d+)\\s+updates?$`,
  'u',
);

/**
 * Makes a value safe to show inside a Slack code span.
 *
 * @param value - The raw value.
 * @returns The escaped value, with no backticks.
 */
function code(value: string): string {
  return `\`${escapeSlack(value).replaceAll('`', "'")}\``;
}

/**
 * Turns a Dependabot pull request title into a short description of the
 * update, as Slack mrkdwn. For example `chore(deps): bump foo from 1.0.0 to
 * 2.0.0` becomes `foo 1.0.0 → 2.0.0`, and a group update becomes
 * `name group, 7 updates`.
 *
 * @param title - The pull request title.
 * @returns The description, or undefined when the title is not a Dependabot
 * title this knows how to read.
 */
export function describeUpdate(title: string): string | undefined {
  const trimmed = title.trim();

  const packageMatch = PACKAGE_TITLE.exec(trimmed);
  if (packageMatch) {
    const [, scope, name, from, to, directory] = packageMatch;
    if (name && from && to) {
      return [
        `${code(name)} ${escapeSlack(from)} → ${escapeSlack(to)}`,
        scope?.includes('dev') ? ' (dev)' : '',
        directory ? ` · ${code(directory)}` : '',
      ].join('');
    }
  }

  const groupMatch = GROUP_TITLE.exec(trimmed);
  if (groupMatch) {
    const [, , name, count] = groupMatch;
    if (name && count) {
      return `${code(name)} group, ${count} ${count === '1' ? 'update' : 'updates'}`;
    }
  }

  return undefined;
}
