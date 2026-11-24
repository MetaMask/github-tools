/** A Slack section block with mrkdwn text. */
export type SlackBlock = {
  type: string;
  text: { type: string; text: string };
};

/** Slack rejects section text over 3000 characters, so stay under it. */
export const MAX_SECTION_LENGTH = 2800;

/** Slack rejects messages with more than 50 blocks. */
export const MAX_BLOCKS = 50;

/**
 * Escapes characters that Slack mrkdwn treats as control characters.
 *
 * @param text - The raw text.
 * @returns The escaped text.
 */
export function escapeSlack(text: string): string {
  return text
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;');
}

/**
 * Shortens text to a maximum length with an ellipsis. Truncate raw text
 * BEFORE escaping and wrapping it in a link, so a cut can never land inside
 * an entity like `&amp;` or a `<url|label>` link.
 *
 * @param text - The text.
 * @param maxLength - The maximum length, ellipsis included.
 * @returns The text, shortened when needed.
 */
export function truncateText(text: string, maxLength: number): string {
  return text.length > maxLength
    ? `${text.slice(0, Math.max(maxLength - 1, 0))}…`
    : text;
}

/**
 * Builds a mrkdwn section block.
 *
 * @param text - The mrkdwn text.
 * @returns The block.
 */
export function section(text: string): SlackBlock {
  return { type: 'section', text: { type: 'mrkdwn', text } };
}

/**
 * Splits a header and lines into section texts that fit Slack's limit. The
 * header is repeated on every section. A single line longer than the budget is
 * hard cut as a last resort, so callers should shorten their own lines first.
 *
 * @param header - The header line.
 * @param lines - The lines to list below the header.
 * @param maxLength - The maximum section length.
 * @returns One or more section texts.
 */
export function chunkSections(
  header: string,
  lines: string[],
  maxLength: number = MAX_SECTION_LENGTH,
): string[] {
  const budget = Math.max(maxLength - header.length - 1, 1);
  const texts: string[] = [];
  let current: string[] = [];
  let length = 0;

  for (const rawLine of lines) {
    const line = truncateText(rawLine, budget);
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
 * Caps a block list at Slack's limit, reserving the last slot for an overflow
 * notice.
 *
 * @param blocks - The blocks.
 * @param describeOmitted - Builds the notice text from the dropped blocks.
 * @param maxBlocks - The maximum number of blocks.
 * @returns The blocks to send and the ones that were dropped.
 */
export function capBlocks(
  blocks: SlackBlock[],
  describeOmitted: (omitted: SlackBlock[]) => string,
  maxBlocks: number = MAX_BLOCKS,
): { blocks: SlackBlock[]; omitted: SlackBlock[] } {
  if (blocks.length <= maxBlocks) {
    return { blocks, omitted: [] };
  }
  const kept = blocks.slice(0, maxBlocks - 1);
  const omitted = blocks.slice(maxBlocks - 1);
  return { blocks: [...kept, section(describeOmitted(omitted))], omitted };
}
