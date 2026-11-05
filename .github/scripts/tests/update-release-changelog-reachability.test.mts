import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { git } from './git-test-environment.mts';
import { isCommitReachableFrom } from '../update-release-changelog.mts';

describe('isCommitReachableFrom', () => {
  let directory: string;
  let shared: string;
  let onlyOnMain: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'reachability-'));
    git(directory, 'init', '-q', '-b', 'main');
    const commit = (file: string): string => {
      writeFileSync(join(directory, file), file);
      git(directory, 'add', file);
      git(directory, 'commit', '-q', '-m', file);
      return git(directory, 'rev-parse', 'HEAD');
    };
    shared = commit('shared.txt');
    git(directory, 'branch', 'release');
    onlyOnMain = commit('main-only.txt');
  });

  afterEach(() => {
    mock.restoreAll();
    rmSync(directory, { recursive: true, force: true });
  });

  it('is true for a commit on the ref and false for one that is not', () => {
    assert.equal(isCommitReachableFrom(shared, 'release', directory), true);
    assert.equal(
      isCommitReachableFrom(onlyOnMain, 'release', directory),
      false,
    );
  });

  it('warns and returns false when Git cannot resolve the commit', () => {
    const warn = mock.method(console, 'warn', () => undefined);

    assert.equal(
      isCommitReachableFrom('f'.repeat(40), 'release', directory),
      false,
    );
    assert.equal(warn.mock.callCount(), 1);
  });

  it('does not warn for an ordinary non-ancestor', () => {
    const warn = mock.method(console, 'warn', () => undefined);

    isCommitReachableFrom(onlyOnMain, 'release', directory);

    assert.equal(warn.mock.callCount(), 0);
  });
});
