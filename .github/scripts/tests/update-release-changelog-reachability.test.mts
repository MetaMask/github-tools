import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isCommitReachableFrom } from '../update-release-changelog.mts';
import { git } from './git-test-environment.mts';

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
    rmSync(directory, { recursive: true, force: true });
  });

  it('is true for a commit on the ref and false for one that is not', () => {
    expect(isCommitReachableFrom(shared, 'release', directory)).toBe(true);
    expect(isCommitReachableFrom(onlyOnMain, 'release', directory)).toBe(false);
  });

  it('warns and returns false when Git cannot resolve the commit', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(isCommitReachableFrom('f'.repeat(40), 'release', directory)).toBe(
      false,
    );
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not warn for an ordinary non-ancestor', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    isCommitReachableFrom(onlyOnMain, 'release', directory);

    expect(warn).toHaveBeenCalledTimes(0);
  });
});
