import { diffLines } from "diff"; // Import diff library
import axios from "axios";

// Manually define types for changelog-parser since it lacks official TypeScript support
interface Release {
    version: string | null;
    title: string;
    date: string | null;
    body: string;
    parsed: Record<string, string[]>;
  }
  
  interface Changelog {
    title: string;
    description: string;
    versions: Release[];
  }
  
  // Import changelog-parser as an untyped module
  const changelogParser: (options: { filePath?: string; text?: string }) => Promise<Changelog> = require("changelog-parser");

  
const repoPath = process.cwd(); // Root directory for any temp storage

// Function to fetch the raw file content from GitHub
async function fetchChangelogFromGitHub(repo: string, branch: string): Promise<string> {
    // Use raw.githubusercontent.com to directly fetch file content
    const url = `https://raw.githubusercontent.com/${repo}/${branch}/CHANGELOG.md`;
    const token = process.env.GITHUB_TOKEN || "";

    try {
        const response = await axios.get(url, {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            responseType: "text", // Ensure we get raw text
        });

        return response.data; // Directly return the raw content
    } catch (error) {
        console.error(`❌ Error fetching CHANGELOG.md from ${branch} on ${repo}:`, error);
        return "";
    }
}

// Function to parse the changelog and extract "Unreleased" section
async function parseChangelog(content: string): Promise<string> {
    try {
        const parsed: Changelog = await changelogParser({ text: content });

        // Try to find the "[Unreleased]" section
        const unreleasedSection = parsed.versions.find(v => v.title.trim().toLowerCase() === "[unreleased]");

        if (!unreleasedSection) {
            console.warn("⚠️ '[Unreleased]' section not found! Check the formatting in CHANGELOG.md.");
            return "";
        }

        return unreleasedSection.body

    } catch (error) {
        console.error("❌ Error parsing CHANGELOG.md:", error);
        return "";
    }
}

function displayDiff(baseChanges: string, featureChanges: string) {

    // Compute the line-by-line differences
const differences = diffLines(baseChanges, featureChanges);

const addedLines: string[] = [];
const removedLines: string[] = [];

// Collect added and removed lines into separate lists
differences.forEach(part => {
    if (part.added) {
        addedLines.push(part.value.trim()); // Trim to remove leading/trailing spaces
    } else if (part.removed) {
        removedLines.push(part.value.trim());
    }
});

// Print the diff summary
console.log("🔍 Diff between base and feature '[Unreleased]' sections:");

if (removedLines.length > 0) {
    console.log("\x1b[31m❌ Removed:\x1b[0m");
    removedLines.forEach(line => console.log(`\x1b[31m- ${line}\x1b[0m`));
} else {
    console.log("\x1b[31m❌ No removed lines.\x1b[0m");
}

if (addedLines.length > 0) {
    console.log("\x1b[32m✅ Added:\x1b[0m");
    addedLines.forEach(line => console.log(`\x1b[32m+ ${line}\x1b[0m`));
} else {
    console.log("\x1b[32m✅ No added lines.\x1b[0m");
}

}

// Main function to validate the changelog
async function validateChangelog(repo: string, baseBranch: string, featureBranch: string) {
    console.log(`🔍 Fetching CHANGELOG.md from GitHub repository: ${repo}`);

    // Fetch CHANGELOG.md from both branches
    const baseChangelogContent = await fetchChangelogFromGitHub(repo, baseBranch);
    const featureChangelogContent = await fetchChangelogFromGitHub(repo, featureBranch);

    if (!featureChangelogContent) {
        console.log("❌ CHANGELOG.md is missing in the feature branch.");
        process.exit(1);
    }

    // Parse the changelogs
    const baseChanges = await parseChangelog(baseChangelogContent);
    const featureChanges = await parseChangelog(featureChangelogContent);

    console.log("🔍 Comparing changelog entries...");

    console.log("Base unreleased section:", baseChanges);
    console.log("Feature unreleased section:", featureChanges);

    displayDiff(baseChanges, featureChanges);

    if (baseChanges === featureChanges) {
        console.log("❌ No new entries detected under '## Unreleased'. Please update the changelog.");
        process.exit(1);
    }

    console.log("✅ CHANGELOG.md has been correctly updated.");
    process.exit(0);
}

// Parse command-line arguments
const args = process.argv.slice(2);
if (args.length < 3) {
    console.error("❌ Usage: node scripts/check-changelog.js <github-repo> <base-branch> <feature-branch>");
    process.exit(1);
}

const [githubRepo, baseBranch, featureBranch] = args;

// Ensure all required arguments are provided
if (!githubRepo || !baseBranch || !featureBranch) {
    console.error("❌ Error: Missing required arguments.");
    console.error("✅ Usage: node scripts/check-changelog.js <github-repo> <base-branch> <feature-branch>");
    process.exit(1);
}

// Run the validation
validateChangelog(githubRepo, baseBranch, featureBranch).catch(error => {
    console.error("❌ Unexpected error:", error);
    process.exit(1);
});
