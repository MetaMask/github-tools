import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  normalizeTeam,
  parseOwnerTeams,
} from '../../dependabot-pr-reminder/teams.mts';

describe('normalizeTeam', () => {
  it('lowercases and strips the @ and metamask/ prefixes', () => {
    assert.equal(normalizeTeam('@MetaMask/Core-Platform'), 'core-platform');
  });
});

describe('parseOwnerTeams', () => {
  it('returns undefined for undefined, empty, and whitespace input', () => {
    assert.equal(parseOwnerTeams(undefined), undefined);
    assert.equal(parseOwnerTeams(''), undefined);
    assert.equal(parseOwnerTeams('  \n '), undefined);
    assert.equal(parseOwnerTeams(' , ,'), undefined);
  });

  it('splits, trims, and drops empty entries', () => {
    assert.deepEqual(parseOwnerTeams(' a, b ,,c '), ['a', 'b', 'c']);
  });
});
