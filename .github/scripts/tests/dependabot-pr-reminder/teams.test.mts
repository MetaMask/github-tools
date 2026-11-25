import { describe, expect, it } from 'vitest';

import {
  parseOwnerTeams,
  parseSharedTeamThreshold,
} from '../../dependabot-pr-reminder/teams.mts';

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

describe('parseSharedTeamThreshold', () => {
  it('returns undefined when unset or blank', () => {
    expect(parseSharedTeamThreshold(undefined)).toBeUndefined();
    expect(parseSharedTeamThreshold(' ')).toBeUndefined();
  });

  it('parses a positive whole number', () => {
    expect(parseSharedTeamThreshold(' 4 ')).toBe(4);
  });

  it.each(['0', '-1', '2.5', 'many'])('rejects %s', (value) => {
    expect(() => parseSharedTeamThreshold(value)).toThrow(
      'SHARED_TEAM_THRESHOLD',
    );
  });
});
