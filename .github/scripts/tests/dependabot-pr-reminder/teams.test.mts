import { describe, expect, it } from 'vitest';

import {
  normalizeTeam,
  parseOwnerTeams,
} from '../../dependabot-pr-reminder/teams.mts';

describe('normalizeTeam', () => {
  it('lowercases and strips the @ and metamask/ prefixes', () => {
    expect(normalizeTeam('@MetaMask/Core-Platform')).toBe('core-platform');
  });
});

describe('parseOwnerTeams', () => {
  it('returns undefined for undefined, empty, and whitespace input', () => {
    expect(parseOwnerTeams(undefined)).toBeUndefined();
    expect(parseOwnerTeams('')).toBeUndefined();
    expect(parseOwnerTeams('  \n ')).toBeUndefined();
    expect(parseOwnerTeams(' , ,')).toBeUndefined();
  });

  it('splits, trims, and drops empty entries', () => {
    expect(parseOwnerTeams(' a, b ,,c ')).toStrictEqual(['a', 'b', 'c']);
  });
});
