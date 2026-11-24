import { describe, expect, it } from 'vitest';

import {
  capBlocks,
  chunkSections,
  escapeSlack,
  section,
  truncateText,
} from '../shared/slack-blocks.mts';

describe('escapeSlack', () => {
  it('escapes &, < and >', () => {
    expect(escapeSlack('a <b> & c')).toBe('a &lt;b&gt; &amp; c');
  });
});

describe('truncateText', () => {
  it('leaves short text alone', () => {
    expect(truncateText('abc', 3)).toBe('abc');
  });

  it('shortens long text to the limit with an ellipsis', () => {
    expect(truncateText('abcdef', 4)).toBe('abc…');
  });
});

describe('chunkSections', () => {
  it('repeats the header and keeps every line within the limit', () => {
    const lines = Array.from({ length: 40 }, (_, index) =>
      `line ${index} `.padEnd(50, 'x'),
    );
    const texts = chunkSections('HEAD', lines, 300);
    expect(texts.length).toBeGreaterThan(1);
    for (const text of texts) {
      expect(text.startsWith('HEAD\n')).toBe(true);
      expect(text.length).toBeLessThanOrEqual(300);
    }
    expect(texts.join('\n')).toContain('line 39');
  });

  it('hard cuts a single line longer than the budget', () => {
    const [text] = chunkSections('H', ['x'.repeat(500)], 100);
    expect(text?.length).toBeLessThanOrEqual(100);
  });

  it('returns nothing for no lines', () => {
    expect(chunkSections('H', [])).toStrictEqual([]);
  });
});

describe('capBlocks', () => {
  const blocks = Array.from({ length: 5 }, (_, index) => section(`b${index}`));

  it('keeps blocks that fit', () => {
    expect(capBlocks(blocks, () => 'x', 5)).toStrictEqual({
      blocks,
      omitted: [],
    });
  });

  it('keeps maxBlocks in total, replacing the tail with a notice', () => {
    const result = capBlocks(blocks, (omitted) => `${omitted.length} more`, 3);
    expect(result.blocks).toHaveLength(3);
    expect(result.blocks.at(-1)?.text.text).toBe('3 more');
    expect(result.omitted).toStrictEqual(blocks.slice(2));
  });
});
