import { expect, test } from 'vitest';

import {
  compareSemver,
  parseReleaseBranch,
  selectHighestLowerVersion,
} from '../release-version-utils.mts';

test('parses supported native and OTA release branches', () => {
  expect(parseReleaseBranch('release/13.50.3')).toStrictEqual({
    version: '13.50.3',
    kind: 'native',
    name: 'release/13.50.3',
  });
  expect(parseReleaseBranch('release/13.50.3-ota')).toStrictEqual({
    version: '13.50.3',
    kind: 'ota',
    name: 'release/13.50.3-ota',
  });
});

test('rejects unsupported release branch names', () => {
  expect(parseReleaseBranch('release/13.50.3-fallback')).toBe(undefined);
  expect(parseReleaseBranch('release/13.50.3.1')).toBe(undefined);
});

test('compares all semantic version components numerically', () => {
  expect(compareSemver('13.50.3', '13.50.2')).toBe(1);
  expect(compareSemver('13.50.3', '13.50.3')).toBe(0);
  expect(compareSemver('13.50.3', '13.51.0')).toBe(-1);
});

test('selects the highest strict predecessor', () => {
  expect(
    selectHighestLowerVersion('13.51.0', [
      '13.49.0',
      '13.50.0',
      '13.50.3',
      '13.51.0',
      '13.52.0',
    ]),
  ).toBe('13.50.3');
  expect(selectHighestLowerVersion('13.50.4', ['13.50.2', '13.50.3'])).toBe(
    '13.50.3',
  );
  expect(
    selectHighestLowerVersion('13.51.0', ['13.51.0', '13.51.1', '14.0.0']),
  ).toBe(undefined);
});
