import axios from 'axios';
import { diffLines } from 'diff';

// Manually define types for changelog-parser since it lacks official TypeScript support
type Release = {
  version: string | null;
  title: string;
  date: string | null;
  body: string;
  parsed: Record<string, string[]>;
};

type Changelog = {
  title: string;
  description: string;
  versions: Release[];
};

const changelogParser: (options: {
  filePath?: string;
  text?: string;
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
}) => Promise<Changelog> = require('changelog-parser');

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
    const response = await axios.get(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      responseType: 'text',
    });

    return response.data;
  } catch (error) {
    console.error(
      `❌ Error fetching CHANGELOG.md from ${branch} on ${repo}:`,
      error,
    );
    return '';
  }
}

/**
 * Parses the content of a CHANGELOG.md file to extract the section marked as "[Unreleased]".
 * @param content - The raw markdown content of the CHANGELOG.md file to be parsed.
 * @returns A promise that resolves to the markdown content of the "[Unreleased]" section,
 * or an empty string if the section is not found or an error occurs.
 */
async function parseChangelog(content: string): Promise<string> {
  try {
    const parsed: Changelog = await changelogParser({ text: content });

    // Try to find the "[Unreleased]" section
    const unreleasedSection = parsed.versions.find(
      (ver) => ver.title.trim().toLowerCase() === '[unreleased]',
    );

    if (!unreleasedSection) {
      console.warn(
        "⚠️ '[Unreleased]' section not found! Check the formatting in CHANGELOG.md.",
      );
      return '';
    }

    return unreleasedSection.body;
  } catch (error) {
    console.error('❌ Error parsing CHANGELOG.md:', error);
    return '';
  }
}

/**
 * Displays the differences between two sets of changelog entries.
 * @param baseChanges - The content of the '[Unreleased]' section from the base branch's CHANGELOG.md.
 * @param featureChanges - The content of the '[Unreleased]' section from the feature branch's CHANGELOG.md.
 */
function displayDiff(baseChanges: string, featureChanges: string) {
  // Compute the line-by-line differences
  const differences = diffLines(baseChanges, featureChanges);

  const addedLines: string[] = [];
  const removedLines: string[] = [];

  // Collect added and removed lines into separate lists
  differences.forEach((part) => {
    if (part.added) {
      addedLines.push(part.value.trim()); // Trim to remove leading/trailing spaces
    } else if (part.removed) {
      removedLines.push(part.value.trim());
    }
  });

  // Print the diff summary
  console.log("🔍 Diff between base and feature '[Unreleased]' sections:");

  if (removedLines.length > 0) {
    console.log('❌ Removed:');
    removedLines.forEach((line) => console.log(`${line}`));
  } else {
    console.log('❌ No removed lines.');
  }

  if (addedLines.length > 0) {
    console.log('✅ Added:');
    addedLines.forEach((line) => console.log(`${line}`));
  } else {
    console.log('✅ No added lines.');
  }
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

  // Fetch CHANGELOG.md from both branches
  const baseChangelogContent = await fetchChangelogFromGitHub(repo, baseBranch);
  const featureChangelogContent = await fetchChangelogFromGitHub(
    repo,
    featureBranch,
  );

  if (!featureChangelogContent) {
    console.error('❌ CHANGELOG.md is missing in the feature branch.');
    throw new Error('❌ CHANGELOG.md is missing in the feature branch.');
  }

  // Parse the changelogs
  const baseChanges = await parseChangelog(baseChangelogContent);
  const featureChanges = await parseChangelog(featureChangelogContent);

  console.log('🔍 Comparing changelog entries...');

  console.log('Base unreleased section:', baseChanges);
  console.log('Feature unreleased section:', featureChanges);

  displayDiff(baseChanges, featureChanges);

  if (baseChanges === featureChanges) {
    console.log(
      "❌ No new entries detected under '## Unreleased'. Please update the changelog.",
    );
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
    '❌ Usage: node scripts/check-changelog.js <github-repo> <base-branch> <feature-branch>',
  );
  throw new Error('❌ Missing required arguments.');
}

const [githubRepo, baseBranch, featureBranch] = args;

// Ensure all required arguments are provided
if (!githubRepo || !baseBranch || !featureBranch) {
  console.error(
    '✅ Usage: ts-node scripts/check-changelog.ts <github-repo> <base-branch> <feature-branch>',
  );
  throw new Error('❌ Missing required arguments.');
}

// Run the validation
validateChangelog(githubRepo, baseBranch, featureBranch).catch((error) => {
  console.error('❌ Unexpected error:', error);
  throw error;
});
