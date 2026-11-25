import { describe, expect, it } from 'vitest';

import {
  parseGuideUrl,
  resolveReminderNote,
} from '../../dependabot-pr-reminder/reminder-note.mts';
import { MAX_SECTION_LENGTH } from '../../shared/slack-blocks.mts';

describe('resolveReminderNote', () => {
  it.each([undefined, 'default', ' default '])(
    'gives the built in note for %j',
    (value) => {
      const note = resolveReminderNote(value, 'MetaMask/core');
      expect(note).toContain('*Is your team tagged?*');
      expect(note).toContain('Check the changelogs');
      expect(note).toContain('Dependabot stops updating it');
    },
  );

  it('fits in one Slack section', () => {
    const note = resolveReminderNote('default', 'MetaMask/core');
    expect(note?.length).toBeLessThan(MAX_SECTION_LENGTH);
  });

  it('gives no note for an empty value, even with a guide', () => {
    expect(resolveReminderNote('', 'MetaMask/core')).toBeUndefined();
    expect(resolveReminderNote('  ', 'MetaMask/core')).toBeUndefined();
    expect(
      resolveReminderNote('', 'MetaMask/core', 'https://example.com/guide'),
    ).toBeUndefined();
  });

  it('uses custom text and fills in the repository', () => {
    expect(resolveReminderNote('Own {repository}.', 'MetaMask/core')).toBe(
      'Own MetaMask/core.',
    );
  });

  it('escapes the repository name', () => {
    expect(resolveReminderNote('Own {repository}.', 'a<b>/c')).toBe(
      'Own a&lt;b&gt;/c.',
    );
  });

  it('adds a link to the guide under the note', () => {
    expect(
      resolveReminderNote('Own it.', 'MetaMask/core', 'https://example.com/g'),
    ).toBe('Own it.\n<https://example.com/g|Read the full guide>');
    expect(
      resolveReminderNote('default', 'MetaMask/core', 'https://example.com/g'),
    ).toMatch(/\n<https:\/\/example\.com\/g\|Read the full guide>$/u);
  });
});

describe('parseGuideUrl', () => {
  it('returns undefined when unset or blank', () => {
    expect(parseGuideUrl(undefined)).toBeUndefined();
    expect(parseGuideUrl(' ')).toBeUndefined();
  });

  it('returns an https URL', () => {
    expect(parseGuideUrl(' https://example.com/guide.md ')).toBe(
      'https://example.com/guide.md',
    );
  });

  it.each([
    'http://example.com',
    'example.com',
    'https://a.com/x>y',
    'https://a b',
  ])('rejects %s', (value) => {
    expect(() => parseGuideUrl(value)).toThrow('GUIDE_URL');
  });
});
