import { parseChangelog } from '@metamask/auto-changelog';
import { execa } from 'execa';
import fs from 'fs/promises';
import path from 'path';

type PackageJson = {
  workspaces: string[];
  private?: boolean;
};

/**
 * Logs an error message in red to the console.
 *
 * @param message - The error message to log.
 */
function logError(message: string): void {
  const redColor = '\x1b[31m';
  const resetColor = '\x1b[0m';
  console.error(`${redColor}${message}${resetColor}`);
}

/**
 * Gets the workspace patterns from package.json.
 *
 * @param repoPath - The path to the repository.
 * @returns Array of workspace patterns.
 */
async function getWorkspacePatterns(repoPath: string): Promise<string[]> {
  const packageJsonPath = path.join(repoPath, 'package.json');
  const content = await fs.readFile(packageJsonPath, 'utf-8');
  const packageJson = JSON.parse(content) as PackageJson;

  if (!Array.isArray(packageJson.workspaces)) {
    return [];
  }

  return packageJson.workspaces;
}

/**
 * This function gets the workspace base and package name from the file path.
 *
 * @param filePath - The path to the file.
 * @param workspacePatterns - The workspace patterns.
 * @returns An object containing the base directory and package name, or null if no match is found.
 */
function getPackageInfo(
  filePath: string,
  workspacePatterns: string[],
): { base: string; package: string } | null {
  for (const pattern of workspacePatterns) {
    // Extract the base directory (everything before the *)
    const wildcardIndex = pattern.indexOf('*');
    if (wildcardIndex === -1) {
      continue;
    }

    const baseDir = pattern.substring(0, wildcardIndex);

    if (filePath.startsWith(baseDir)) {
      // Extract the package name (everything between baseDir and the next slash)
      const remainingPath = filePath.substring(baseDir.length);
      const nextSlashIndex = remainingPath.indexOf('/');

      if (nextSlashIndex !== -1) {
        const packageName = remainingPath.substring(0, nextSlashIndex);
        return {
          base: baseDir,
          package: packageName,
        };
      }
    }
  }

  return null;
}

/**
 * Gets the list of changed files between the current branch and baseRef.
 *
 * @param repoPath - The path to the repository.
 * @param baseRef - The base reference to compare against.
 * @returns Array of changed file paths.
 */
async function getChangedFiles(
  repoPath: string,
  baseRef: string,
): Promise<string[]> {
  try {
    await execa('git', ['fetch', 'origin', baseRef], {
      cwd: repoPath,
    });

    const { stdout } = await execa(
      'git',
      ['diff', '--name-only', `origin/${baseRef}...HEAD`],
      {
        cwd: repoPath,
      },
    );

    return stdout.split('\n').filter(Boolean);
  } catch (error) {
    logError(
      `Failed to get changed files: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    throw error;
  }
}

/**
 * Checks if a package.json file only has version changes by comparing the diff output.
 * Returns true if the diff contains exactly two lines (one addition and one removal)
 * and both lines are version changes with the same format (with or without trailing comma).
 *
 * @param repoPath - The path to the repository.
 * @param filePath - The path to the package.json file.
 * @param baseRef - The base reference to compare against.
 * @returns Promise that resolves to true if only version was changed, false otherwise.
 */
async function isVersionOnlyChange(
  repoPath: string,
  filePath: string,
  baseRef: string,
): Promise<boolean> {
  try {
    const { stdout } = await execa(
      'git',
      ['diff', `origin/${baseRef}...HEAD`, '--', filePath],
      {
        cwd: repoPath,
      },
    );

    if (!stdout) {
      return false;
    }

    // Split the diff into lines and filter out the diff header lines (+++ and ---)
    const lines = stdout
      .split('\n')
      .filter((line) => line.startsWith('+') || line.startsWith('-'))
      .filter((line) => !line.startsWith('+++') && !line.startsWith('---'));

    // If we have exactly 2 lines (one addition and one removal) and they both contain version changes
    if (lines.length === 2) {
      const versionRegex = /^[+-]\s*"version":\s*"[^"]+"\s*,?\s*$/mu;
      return lines.every((line) => versionRegex.test(line));
    }

    return false;
  } catch (error) {
    logError(
      `Failed to check ${filePath} changes: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

/**
 * Checks if a package is marked as private in its package.json.
 *
 * @param repoPath - The path to the repository.
 * @param filePath - The path to the package.json file.
 * @returns Promise that resolves to true if the package is private, false otherwise.
 */
async function isPrivatePackage(
  repoPath: string,
  filePath: string,
): Promise<boolean> {
  try {
    const content = await fs.readFile(path.join(repoPath, filePath), 'utf-8');
    const packageJson = JSON.parse(content) as PackageJson;
    return packageJson.private === true;
  } catch (error) {
    logError(
      `Failed to check if package is private: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

/**
 * Reads and validates a changelog file.
 *
 * @param changelogPath - The path to the changelog file to check.
 * @param prNumber - The pull request number.
 */
async function checkChangelogFile(
  changelogPath: string,
  prNumber: string,
): Promise<void> {
  try {
    const changelogContent = await fs.readFile(changelogPath, 'utf-8');

    if (!changelogContent) {
      throw new Error('CHANGELOG.md is empty or missing');
    }

    const changelogUnreleasedChanges = parseChangelog({
      changelogContent,
      repoUrl: '', // Not needed as we're only parsing unreleased changes
    }).getReleaseChanges('Unreleased');

    if (
      !Object.values(changelogUnreleasedChanges)
        .flat()
        .some((entry) => entry.includes(`[#${prNumber}]`))
    ) {
      throw new Error(
        "This PR contains changes that might require documentation in the changelog. If these changes aren't user-facing, consider adding the 'no-changelog' label instead.",
      );
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`CHANGELOG.md not found at ${changelogPath}`);
    }
    throw error;
  }
}

/**
 * Gets the list of changed packages from the changed files.
 *
 * @param files - The list of changed files.
 * @param workspacePatterns - The workspace patterns.
 * @param repoPath - The path to the repository.
 * @param baseRef - The base reference to compare against.
 * @returns Array of changed package information.
 */
async function getChangedPackages(
  files: string[],
  workspacePatterns: string[],
  repoPath: string,
  baseRef: string,
): Promise<
  {
    base: string;
    package: string;
  }[]
> {
  const changedPackages = new Map<string, { base: string; package: string }>();
  const privatePackageCache = new Map<string, boolean>();

  for (const file of files) {
    // Skip workflow files
    if (file.startsWith('.github/workflows/')) {
      continue;
    }

    const packageInfo = getPackageInfo(file, workspacePatterns);
    if (packageInfo) {
      // Check if we've already determined if this package is private
      let isPrivate = privatePackageCache.get(packageInfo.package);
      if (isPrivate === undefined) {
        // If not in cache, check and cache the result
        const packageJsonPath = path.join(
          packageInfo.base,
          packageInfo.package,
          'package.json',
        );
        isPrivate = await isPrivatePackage(repoPath, packageJsonPath);
        privatePackageCache.set(packageInfo.package, isPrivate);
      }

      if (isPrivate) {
        continue;
      }

      // Skip test files, docs, and changelog files
      if (
        !file.match(/\.(test|spec)\./u) &&
        !file.includes('__tests__/') &&
        !file.includes('/docs/') &&
        !file.endsWith('CHANGELOG.md')
      ) {
        // If the file is package.json, check if it's only a version change
        if (file.endsWith('package.json')) {
          const isVersionOnly = await isVersionOnlyChange(
            repoPath,
            file,
            baseRef,
          );
          if (isVersionOnly) {
            continue;
          }
        }
        changedPackages.set(packageInfo.package, packageInfo);
      }
    }
  }

  return Array.from(changedPackages.values());
}

/**
 * Main function to run the changelog check.
 */
async function main() {
  // Parse command-line arguments
  const args = process.argv.slice(2);

  const [repoPath, baseRef, prNumber] = args;

  if (!repoPath || !baseRef || !prNumber) {
    throw new Error(
      'Missing required arguments. Usage: ts-node src/check-changelog.ts <repo-path> <base-ref>',
    );
  }

  const fullRepoPath = path.resolve(process.cwd(), repoPath);

  // Verify the repo path exists
  try {
    await fs.access(fullRepoPath);
  } catch {
    throw new Error(`Repository path not found: ${fullRepoPath}`);
  }

  const workspacePatterns = await getWorkspacePatterns(fullRepoPath);

  if (workspacePatterns.length > 0) {
    console.log(
      'Running in monorepo mode - checking changelogs for changed packages...',
    );

    const changedFiles = await getChangedFiles(fullRepoPath, baseRef);
    if (!changedFiles.length) {
      console.log('No changed files found. Exiting successfully.');
      return;
    }

    const changedPackages = await getChangedPackages(
      changedFiles,
      workspacePatterns,
      fullRepoPath,
      baseRef,
    );
    if (!changedPackages.length) {
      console.log(
        'No package code changes detected that would require changelog updates.',
      );
      return;
    }

    const checkResults = await Promise.all(
      changedPackages.map(async (pkgInfo) => {
        try {
          await checkChangelogFile(
            path.join(
              fullRepoPath,
              pkgInfo.base,
              pkgInfo.package,
              'CHANGELOG.md',
            ),
            prNumber,
          );
          console.log(
            `CHANGELOG.md for ${pkgInfo.package} has been correctly updated.`,
          );
          return { package: pkgInfo.package, success: true };
        } catch (error) {
          logError(
            `Changelog check failed for package ${pkgInfo.package}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return { package: pkgInfo.package, success: false, error };
        }
      }),
    );

    const hasError = checkResults.some((result) => !result.success);

    if (hasError) {
      throw new Error('One or more changelog checks failed');
    }
  } else {
    console.log(
      'Running in single-repo mode - checking changelog for the entire repository...',
    );
    await checkChangelogFile(path.join(fullRepoPath, 'CHANGELOG.md'), prNumber);
    console.log('CHANGELOG.md has been correctly updated.');
  }
}

main().catch((error) => {
  logError(error.message);
  // eslint-disable-next-line n/no-process-exit
  process.exit(1);
});
