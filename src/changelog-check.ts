import fetch from 'node-fetch';
import { parseChangelog } from '@metamask/auto-changelog';

/**
 * Asynchronously fetches the CHANGELOG.md file content from a specified GitHub repository and branch.
 * The function constructs a URL to access the raw content of the file using GitHub's raw content service.
 * It handles authorization using an optional GitHub token from environment variables.
 *
 * @param repo - The full name of the repository (e.g., "owner/repo").
 * @param branch - The branch from which to fetch the CHANGELOG.md file.
 * @returns A promise that resolves to the content of the CHANGELOG.md file as a string.
 * If the fetch operation fails, it logs an error and returns an empty string.
 */
async function fetchChangelogFromGitHub(
  repo: string,
  branch: string,
): Promise<string> {
  const url = `https://raw.githubusercontent.com/${repo}/${branch}/CHANGELOG.md`;
  // eslint-disable-next-line n/no-process-env
  const token = process.env.GITHUB_TOKEN ?? '';

  try {
    const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
    const response = await fetch(url, {
      headers: headers
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    return await response.text();
  } catch (error) {
    console.error(
      `❌ Error fetching CHANGELOG.md from ${branch} on ${repo}:`,
      error
    );
    throw error;
  }
}


/**
 * Determines if there's a difference in the changelog entries between the base and feature branches.
 * @param baseChanges - The content of the '[Unreleased]' section from the base branch's CHANGELOG.md.
 * @param featureChanges - The content of the '[Unreleased]' section from the feature branch's CHANGELOG.md.
 */
function compareChangeLogs(baseChanges: string[], featureChanges: string[]): boolean {
  const newEntries = featureChanges.filter(entry => !baseChanges.includes(entry));

  // Log and return true if there are new entries
  if (newEntries.length > 0) {
    console.log('New entries in feature branch:', newEntries);
    return true;
  }

  // Check if the number of entries has changed
  if (baseChanges.length !== featureChanges.length) {
    console.log('The number of entries has changed. Base branch has', baseChanges.length, 'entries, while feature branch has', featureChanges.length, 'entries.');
    return true;
  }

  // If no new entries and the size has not changed, return false
  return false;
}

/**
 * Validates that the CHANGELOG.md in a feature branch has been updated correctly by comparing it
 * against the CHANGELOG.md in the base branch.
 * @param repo - The GitHub repository from which to fetch the CHANGELOG.md file.
 * @param baseBranch - The base branch (typically 'main' or 'master') to compare against.
 * @param featureBranch - The feature branch that should contain the updated CHANGELOG.md.
 */
async function validateChangelog(
  repo: string,
  baseBranch: string,
  featureBranch: string,
) {
  console.log(`🔍 Fetching CHANGELOG.md from GitHub repository: ${repo}`);

  const [baseChangelogContent, featureChangelogContent] = await Promise.all([
    fetchChangelogFromGitHub(repo, baseBranch),
    fetchChangelogFromGitHub(repo, featureBranch),
  ]);

  if (!featureChangelogContent) {
    throw new Error('❌ CHANGELOG.md is missing in the feature branch.');
  }

  const baseUnreleasedChanges = parseChangelog({
    changelogContent: baseChangelogContent,
    repoUrl: '', // Not needed as we're only parsing unreleased changes
  }).getReleaseChanges('Unreleased');

  const featureUnreleasedChanges = parseChangelog({
    changelogContent: featureChangelogContent,
    repoUrl: '', // Not needed as we're only parsing unreleased changes
  }).getReleaseChanges('Unreleased');


  const baseChanges = Object.values(baseUnreleasedChanges).flat();
  const featureChanges = Object.values(featureUnreleasedChanges).flat();

  console.log('🔍 Comparing changelog entries...');

  console.log('Base unreleased section:', baseUnreleasedChanges);
  console.log('Feature unreleased section:', featureUnreleasedChanges);


  const hasChanges = compareChangeLogs(baseChanges, featureChanges);

  if(!hasChanges) {
    throw new Error(
      "❌ No new entries detected under '## Unreleased'. Please update the changelog.",
    );
  }

  console.log('✅ CHANGELOG.md has been correctly updated.');
}

// Parse command-line arguments
const args = process.argv.slice(2);
if (args.length < 3) {
  console.error(
    '❌ Usage: ts-node scripts/check-changelog.js <github-repo> <base-branch> <feature-branch>',
  );
  throw new Error('❌ Missing required arguments.');
}

const [githubRepo, baseBranch, featureBranch] = args;

// Ensure all required arguments are provided
if (!githubRepo || !baseBranch || !featureBranch) {
  console.error(
    '❌ Usage: ts-node src/check-changelog.ts <github-repo> <base-branch> <feature-branch>',
  );
  throw new Error('❌ Missing required arguments.');
}

// Run the validation
validateChangelog(githubRepo, baseBranch, featureBranch).catch((error) => {
  console.error('❌ Unexpected error:', error);
  throw error;
});
