import type { Octokit } from '@octokit/rest';

import { DIFF_PREFILTER } from './constants';
import type { RepoId } from './github-api';
import type { PlatformConfig } from './types';

const PULL_NUMBER = 'pull_number';
const PER_PAGE = 'per_page';
const PREVIOUS_FILENAME = 'previous_filename';

const TEST_PATH =
  /(?:^|\/)(?:__tests__\/|(?:[^/]+\.)?(?:test|spec)\.[jt]sx?$)/u;

export type PullRequestTsDiff = {
  files: string[];
  mentionsAnalytics: boolean;
};

type PullsFile = {
  filename: string;
  patch?: string | null;
  [PREVIOUS_FILENAME]?: string;
};

/**
 * Lists non-test TypeScript paths on a pull request and whether their patches
 * mention analytics APIs.
 *
 * Why: `pulls.listFiles` is GitHub's three-dot PR file list (merge-base → head),
 * so a branch that lagged the base tip does not look like it reverted unrelated
 * analytics landings.
 *
 * @param octokit - Client-repo Octokit.
 * @param repoId - Mobile or Extension repo.
 * @param prNumber - Pull request number.
 * @returns Changed TS paths and the analytics pre-filter result.
 */
export async function loadPullRequestTsDiff(
  octokit: Octokit,
  repoId: RepoId,
  prNumber: number,
): Promise<PullRequestTsDiff> {
  const items = await octokit.paginate<PullsFile>(
    'GET /repos/{owner}/{repo}/pulls/{pull_number}/files',
    {
      owner: repoId.owner,
      repo: repoId.repo,
      [PULL_NUMBER]: prNumber,
      [PER_PAGE]: 100,
    },
  );

  const files = new Set<string>();
  let mentionsAnalytics = false;

  for (const item of items) {
    const candidates = [item.filename];
    const renamedFrom = item[PREVIOUS_FILENAME];
    if (renamedFrom) {
      candidates.push(renamedFrom);
    }

    const tsPaths = candidates.filter(isNonTestTsFile);
    if (tsPaths.length === 0) {
      continue;
    }

    for (const filePath of tsPaths) {
      files.add(filePath);
    }

    if (item.patch === undefined || item.patch === null) {
      mentionsAnalytics = true;
      continue;
    }
    if (DIFF_PREFILTER.test(item.patch)) {
      mentionsAnalytics = true;
    }
  }

  return { files: [...files], mentionsAnalytics };
}

/**
 * True when the PR file list looks like an analytics change.
 *
 * @param diff - Changed TS paths and pre-filter result.
 * @param config - Platform config (catalog path).
 * @returns Whether generate should walk the files.
 */
export function hasAnalyticsDiff(
  diff: PullRequestTsDiff,
  config: PlatformConfig,
): boolean {
  return diff.mentionsAnalytics || diff.files.includes(config.catalogFile);
}

/**
 * Returns file contents at a git ref, or null when the path is missing.
 *
 * @param octokit - Client-repo Octokit.
 * @param repoId - Mobile or Extension repo.
 * @param filePath - Path relative to the repository root.
 * @param sha - Commit SHA.
 * @returns File text, or null on 404 / non-file.
 */
export async function getFileAtRef(
  octokit: Octokit,
  repoId: RepoId,
  filePath: string,
  sha: string,
): Promise<string | null> {
  try {
    const { data } = await octokit.repos.getContent({
      owner: repoId.owner,
      repo: repoId.repo,
      path: filePath,
      ref: sha,
    });
    if (Array.isArray(data) || !('content' in data) || !data.content) {
      return null;
    }
    return Buffer.from(data.content, 'base64').toString('utf8');
  } catch (error: unknown) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * True for production TypeScript paths the analytics extractor walks.
 *
 * @param filePath - Path relative to the repository root.
 * @returns Whether the path is a non-test `.ts` / `.tsx` file.
 */
function isNonTestTsFile(filePath: string): boolean {
  return (
    (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) &&
    !TEST_PATH.test(filePath)
  );
}

/**
 * True when an Octokit error is a missing object.
 *
 * @param error - Thrown value.
 * @returns Whether the error is HTTP 404.
 */
function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    error.status === 404
  );
}
