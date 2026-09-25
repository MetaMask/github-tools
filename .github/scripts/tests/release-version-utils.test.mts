import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compareSemver,
  parseReleaseBranch,
  selectHighestLowerVersion,
} from '../release-version-utils.mts';

test('parses supported native and OTA release branches', () => {
  assert.deepEqual(parseReleaseBranch('release/13.50.3'), {
    version: '13.50.3',
    kind: 'native',
    name: 'release/13.50.3',
  });
  assert.deepEqual(parseReleaseBranch('release/13.50.3-ota'), {
    version: '13.50.3',
    kind: 'ota',
    name: 'release/13.50.3-ota',
  });
});

test('rejects unsupported release branch names', () => {
  assert.equal(parseReleaseBranch('release/13.50.3-fallback'), undefined);
  assert.equal(parseReleaseBranch('release/13.50.3.1'), undefined);
});

test('compares all semantic version components numerically', () => {
  assert.equal(compareSemver('13.50.3', '13.50.2'), 1);
  assert.equal(compareSemver('13.50.3', '13.50.3'), 0);
  assert.equal(compareSemver('13.50.3', '13.51.0'), -1);
});

test('selects the highest strict predecessor', () => {
  assert.equal(
    selectHighestLowerVersion('13.51.0', [
      '13.49.0',
      '13.50.0',
      '13.50.3',
      '13.51.0',
      '13.52.0',
    ]),
    '13.50.3',
  );
  assert.equal(
    selectHighestLowerVersion('13.50.4', ['13.50.2', '13.50.3']),
    '13.50.3',
  );
  assert.equal(
    selectHighestLowerVersion('13.51.0', ['13.51.0', '13.51.1', '14.0.0']),
    undefined,
  );
});
