import type { Octokit } from '@octokit/rest';
import type { PastFixExample } from '../types';

const MAX_PAST_FIXES = 5;
const MAX_DIFF_LENGTH = 5000;

/**
 * Filters a unified diff to only include hunks touching test/e2e files,
 * keeping diffs focused and within context budget.
 */
function filterDiffToTestFiles(diff: string): string {
  const fileSections = diff.split(/^diff --git /m);
  const testSections = fileSections.filter(
    (section) =>
      section.includes('test/e2e/') ||
      section.includes('page-objects/') ||
      section.includes('.spec.'),
  );

  const joined = testSections
    .map((section) => `diff --git ${section}`)
    .join('\n');

  if (joined.length > MAX_DIFF_LENGTH) {
    return `${joined.substring(0, MAX_DIFF_LENGTH)}\n... (diff truncated)`;
  }
  return joined;
}

function sanitizeSearchQuery(raw: string): string {
  return raw
    .replace(/['"\\`{}[\]()]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 80);
}

async function searchPRs(
  octokit: Octokit,
  owner: string,
  repo: string,
  query: string,
): Promise<PastFixExample[]> {
  const { data: searchResults } = await octokit.rest.search.issuesAndPullRequests({
    q: query,
    per_page: 3,
  });

  const fixes: PastFixExample[] = [];

  for (const item of searchResults.items) {
    try {
      const { data: diff } = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: item.number,
        mediaType: { format: 'diff' },
      });

      const diffText = typeof diff === 'string' ? diff : String(diff);
      const filteredDiff = filterDiffToTestFiles(diffText);

      if (filteredDiff.trim()) {
        fixes.push({
          prNumber: item.number,
          title: item.title,
          diffContent: filteredDiff,
        });
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to fetch diff for PR #${item.number}: ${message}`);
    }
  }

  return fixes;
}

export async function searchFixesByKeyword(
  octokit: Octokit,
  owner: string,
  repo: string,
  keyword: string,
): Promise<PastFixExample[]> {
  const sanitized = sanitizeSearchQuery(keyword);
  if (!sanitized) return [];

  const queries = [
    `repo:${owner}/${repo} is:pr is:merged "flaky" "${sanitized}"`,
    `repo:${owner}/${repo} is:pr is:merged "${sanitized}" test e2e`,
  ];

  for (const q of queries) {
    try {
      const fixes = await searchPRs(octokit, owner, repo, q);
      if (fixes.length > 0) return fixes;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Search query failed ("${q.substring(0, 60)}..."): ${message}`);
    }
  }

  return [];
}

export async function fetchPastFixes(
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<PastFixExample[]> {
  try {
    return await searchPRs(
      octokit,
      owner,
      repo,
      `repo:${owner}/${repo} is:pr is:merged "flaky" test e2e sort:updated-desc`,
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to search for past flaky test fixes: ${message}`);
    return [];
  }
}
