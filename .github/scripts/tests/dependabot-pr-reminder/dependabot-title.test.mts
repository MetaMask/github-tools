import { describe, expect, it } from 'vitest';

import { describeUpdate } from '../../dependabot-pr-reminder/dependabot-title.mts';

describe('describeUpdate', () => {
  it('reads a package bump', () => {
    expect(
      describeUpdate('chore(deps): bump @noble/curves from 1.9.7 to 2.4.0'),
    ).toBe('`@noble/curves` 1.9.7 → 2.4.0');
  });

  it('marks a dev dependency', () => {
    expect(
      describeUpdate('chore(deps-dev): bump jsdom from 27.4.0 to 31.0.1'),
    ).toBe('`jsdom` 27.4.0 → 31.0.1 (dev)');
  });

  it('reads a title without a prefix and with a directory', () => {
    expect(describeUpdate('Bump foo from 1.0.0 to 1.1.0 in /packages/a')).toBe(
      '`foo` 1.0.0 → 1.1.0 · `/packages/a`',
    );
  });

  it('reads a group update across directories', () => {
    expect(
      describeUpdate(
        'chore(deps): bump the external-non-major group across 1 directory with 7 updates',
      ),
    ).toBe('`external-non-major` group, 7 updates');
  });

  it('reads a group update in a directory and a single update', () => {
    expect(describeUpdate('Bump the tools group in /app with 1 update')).toBe(
      '`tools` group, 1 update',
    );
  });

  it('returns undefined for titles it does not know', () => {
    expect(describeUpdate('Bump a and b')).toBeUndefined();
    expect(describeUpdate('Something else entirely')).toBeUndefined();
  });

  it('escapes Slack characters and backticks', () => {
    expect(describeUpdate('bump a&b from 1<2 to 3>4')).toBe(
      '`a&amp;b` 1&lt;2 → 3&gt;4',
    );
  });
});
