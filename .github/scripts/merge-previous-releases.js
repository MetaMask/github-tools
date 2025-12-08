#!/usr/bin/env node

/**
 * Merge Previous Release Branches Script
 *
 * This script is triggered when a new release branch is created (e.g., release/2.1.2).
 * It finds all previous release branches and merges them into the new release branch.
 *
 * Key behaviors:
 * - Merges ALL older release branches into the new one
 * - For merge conflicts, favors the destination branch (new release)
 * - Both branches remain open after merge
 * - Fails fast on errors to prevent pushing partial merges
 *
 * Environment variables:
 * - NEW_RELEASE_BRANCH: The newly created release branch (e.g., release/2.1.2)
 */

const { promisify } = require('util');
const exec = promisify(require('child_process').exec);

/**
 * Parse a release branch name to extract version components
 * @param {string} branchName - Branch name like "release/2.1.2"
 * @returns {object|null} - { major, minor, patch } or null if not a valid release branch
 */
function parseReleaseVersion(branchName) {
  // Match release/X.Y.Z format (does not match release candidates like release/2.1.2-rc.1)
  const match = branchName.match(/^release\/(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    return null;
  }
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
  };
}

/**
 * Compare two version objects
 * @returns {number} - negative if a < b, positive if a > b, 0 if equal
 */
function compareVersions(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/**
 * Execute a git command and log it
 */
async function gitExec(command, options = {}) {
  const { ignoreError = false } = options;
  console.log(`Executing: git ${command}`);
  try {
    const { stdout, stderr } = await exec(`git ${command}`);
    if (stdout.trim()) console.log(stdout.trim());
    if (stderr.trim()) console.log(stderr.trim());
    return { stdout, stderr, success: true };
  } catch (error) {
    if (ignoreError) {
      console.warn(`Warning: ${error.message}`);
      return { stdout: error.stdout, stderr: error.stderr, success: false, error };
    }
    throw error;
  }
}

/**
 * Get all remote release branches
 */
async function getReleaseBranches() {
  await gitExec('fetch origin');
  const { stdout } = await exec('git branch -r --list "origin/release/*"');
  return stdout
    .split('\n')
    .map((branch) => branch.trim().replace('origin/', ''))
    .filter((branch) => branch && parseReleaseVersion(branch));
}

/**
 * Check if a branch has already been merged into the current branch. If yes, skip the merge.
 * @param {string} sourceBranch - The branch to check if it has already been merged into the current branch
 * @returns {Promise<boolean>} - True if the branch has already been merged into the current branch, false otherwise
 */
async function isBranchMerged(sourceBranch) {
  try {
    // Check if the source branch's HEAD is an ancestor of current HEAD
    const { stdout } = await exec(
      `git merge-base --is-ancestor origin/${sourceBranch} HEAD && echo "merged" || echo "not-merged"`,
    );
    return stdout.trim() === 'merged';
  } catch {
    // If the command fails, assume not merged
    return false;
  }
}

/**
 * Merge a source branch into the current branch, favoring current branch on conflicts
 * Uses approach similar to stable-sync.js
 */
async function mergeWithFavorDestination(sourceBranch, destBranch) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Merging ${sourceBranch} into ${destBranch}`);
  console.log('='.repeat(60));

  // Check if already merged
  const alreadyMerged = await isBranchMerged(sourceBranch);
  if (alreadyMerged) {
    console.log(`Branch ${sourceBranch} is already merged into ${destBranch}. Skipping.`);
    return { skipped: true };
  }

  // Try to merge with "ours" strategy for conflicts (favors current branch)
  const mergeResult = await gitExec(
    `merge origin/${sourceBranch} -X ours --no-edit -m "Merge ${sourceBranch} into ${destBranch}"`,
    { ignoreError: true },
  );

  if (!mergeResult.success) {
    // If merge still fails (shouldn't happen with -X ours, but just in case)
    console.log('Merge had conflicts, resolving by favoring destination branch...');

    // Add all files and resolve conflicts by keeping destination version
    await gitExec('add .');

    // For any remaining conflicts, checkout our version
    try {
      const { stdout: conflictFiles } = await exec('git diff --name-only --diff-filter=U');
      if (conflictFiles.trim()) {
        for (const file of conflictFiles.trim().split('\n')) {
          if (file) {
            console.log(`Resolving conflict in ${file} by keeping destination version`);
            await gitExec(`checkout --ours "${file}"`);
            await gitExec(`add "${file}"`);
          }
        }
      }
    } catch (e) {
      // No conflicts to resolve
    }

    // Complete the merge
    const { stdout: status } = await exec('git status --porcelain');
    if (status.trim()) {
      const commitResult = await gitExec(
        `commit -m "Merge ${sourceBranch} into ${destBranch}" --no-verify`,
        { ignoreError: true },
      );
      if (!commitResult.success) {
        throw new Error(`Failed to commit merge of ${sourceBranch}: ${commitResult.error?.message}`);
      }
    }
  }

  console.log(`Successfully merged ${sourceBranch} into ${destBranch}`);
  return { skipped: false };
}

async function main() {
  const newReleaseBranch = process.env.NEW_RELEASE_BRANCH;

  if (!newReleaseBranch) {
    console.error('Error: NEW_RELEASE_BRANCH environment variable is not set');
    process.exit(1);
  }

  console.log(`New release branch: ${newReleaseBranch}`);

  const newVersion = parseReleaseVersion(newReleaseBranch);
  if (!newVersion) {
    console.error(
      `Error: ${newReleaseBranch} is not a valid release branch (expected format: release/X.Y.Z)`,
    );
    process.exit(1);
  }

  console.log(`Parsed version: ${newVersion.major}.${newVersion.minor}.${newVersion.patch}`);

  // Get all release branches
  const allReleaseBranches = await getReleaseBranches();
  console.log(`\nFound ${allReleaseBranches.length} release branches:`);
  allReleaseBranches.forEach((b) => console.log(`  - ${b}`));

  // Filter to only branches older than the new one, sorted from oldest to newest
  const olderBranches = allReleaseBranches
    .filter((branch) => {
      const version = parseReleaseVersion(branch);
      return version && compareVersions(version, newVersion) < 0;
    })
    .sort((a, b) => {
      const versionA = parseReleaseVersion(a);
      const versionB = parseReleaseVersion(b);
      return compareVersions(versionA, versionB);
    });

  if (olderBranches.length === 0) {
    console.log('\nNo older release branches found. Nothing to merge.');
    return;
  }

  console.log(`\nOlder release branches found (oldest to newest):`);
  olderBranches.forEach((b) => console.log(`  - ${b}`));

  // Merge all older branches
  const branchesToMerge = olderBranches;
  console.log(`\nWill merge all ${branchesToMerge.length} older branches.`);

  // We should already be on the new release branch (checkout was done in the workflow)
  // But let's verify and ensure we're on the right branch
  const { stdout: currentBranch } = await exec('git branch --show-current');
  if (currentBranch.trim() !== newReleaseBranch) {
    console.log(`Switching to ${newReleaseBranch}...`);
    await gitExec(`checkout ${newReleaseBranch}`);
  }

  // Merge each branch (fail fast on errors)
  let mergedCount = 0;
  let skippedCount = 0;

  for (const olderBranch of branchesToMerge) {
    const result = await mergeWithFavorDestination(olderBranch, newReleaseBranch);
    if (result.skipped) {
      skippedCount++;
    } else {
      mergedCount++;
    }
  }

  // Only push if we actually merged something
  if (mergedCount > 0) {
    console.log('\nPushing merged changes...');
    await gitExec(`push origin ${newReleaseBranch}`);
  } else {
    console.log('\nNo new merges were made (all branches were already merged).');
  }

  console.log('\n' + '='.repeat(60));
  console.log('Merge complete!');
  console.log(`  Branches merged: ${mergedCount}`);
  console.log(`  Branches skipped (already merged): ${skippedCount}`);
  console.log(`All source branches remain open as requested.`);
  console.log('='.repeat(60));
}

main().catch((error) => {
  console.error(`\nFatal error: ${error.message}`);
  console.error('Aborting to prevent pushing partial merges.');
  process.exit(1);
});
