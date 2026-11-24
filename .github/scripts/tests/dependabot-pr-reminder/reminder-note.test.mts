import { describe, expect, it } from 'vitest';

import { resolveReminderNote } from '../../dependabot-pr-reminder/reminder-note.mts';
import { CI_ICONS } from '../../dependabot-pr-reminder/slack-payload.mts';
import { MAX_SECTION_LENGTH } from '../../shared/slack-blocks.mts';

describe('resolveReminderNote', () => {
  it.each([undefined, 'default', ' default '])(
    'gives the built in note for %j',
    (value) => {
      const note = resolveReminderNote(value, 'MetaMask/core');
      expect(note).toContain('Some packages in MetaMask/core');
      expect(note).toContain('1. Read the changelogs');
      expect(note).toContain('5. Merge once CI passes');
    },
  );

  it('explains every icon the message uses', () => {
    const note = resolveReminderNote('default', 'MetaMask/core');
    for (const icon of Object.values(CI_ICONS)) {
      expect(note).toContain(icon);
    }
  });

  it('fits in one Slack section', () => {
    const note = resolveReminderNote('default', 'MetaMask/core');
    expect(note?.length).toBeLessThan(MAX_SECTION_LENGTH);
  });

  it('gives no note for an empty value', () => {
    expect(resolveReminderNote('', 'MetaMask/core')).toBeUndefined();
    expect(resolveReminderNote('  ', 'MetaMask/core')).toBeUndefined();
  });

  it('uses custom text and fills in the repository', () => {
    expect(resolveReminderNote('Own {repository}.', 'MetaMask/core')).toBe(
      'Own MetaMask/core.',
    );
  });

  it('escapes the repository name', () => {
    expect(resolveReminderNote('default', 'a<b>/c')).toContain('a&lt;b&gt;/c');
  });
});
