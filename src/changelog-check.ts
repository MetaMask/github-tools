import { parseChangelog } from '@metamask/auto-changelog';
import { execa } from 'execa';
import fs from 'fs/promises';
import path from 'path';
import { SemVer } from 'semver';

type PackageJson = {
  workspaces: string[];
  private?: boolean;
  version: string;
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
 * Extracts lines that are within devDependencies sections from the diff output.
 *
 * @param diffOutput - The full diff output.
 * @param nonVersionLines - The non-version change lines to filter.
 * @returns Array of lines that are within devDependencies sections.
 */
const getDevDependencyLines = (
  diffOutput: string,
  nonVersionLines: string[],
): string[] => {
  const allLines = diffOutput.split('\n');
  const devDependencyLines: string[] = [];

  const devDepSectionBoundaries: { start: number; end: number }[] = [];

  for (let i = 0; i < allLines.length; i++) {
    const line = allLines[i];

    if (line?.includes('"devDependencies"') && line.includes(':')) {
      const startIndex = i;
      let endIndex = allLines.length - 1;

      // Find the end of this section (next section or closing brace)
      for (let j = i + 1; j < allLines.length; j++) {
        const nextLine = allLines[j];
        if (
          nextLine &&
          (nextLine.includes('"dependencies"') ||
            nextLine.includes('"peerDependencies"') ||
            nextLine.includes('"scripts"') ||
            nextLine.includes('"engines"') ||
            nextLine.includes('"main"') ||
            nextLine.includes('"types"') ||
            nextLine.includes('"files"')) &&
          nextLine.includes(':')
        ) {
          endIndex = j - 1;
          break;
        }
      }

      devDepSectionBoundaries.push({ start: startIndex, end: endIndex });
    }
  }

  // Check which nonVersionLines fall within devDependencies sections
  for (const changeLine of nonVersionLines) {
    const lineIndex = allLines.findIndex((line) => line === changeLine);
    if (lineIndex !== -1) {
      // Check if this line falls within any devDependencies section
      const isInDevDeps = devDepSectionBoundaries.some(
        (section) => lineIndex >= section.start && lineIndex <= section.end,
      );

      if (isInDevDeps) {
        devDependencyLines.push(changeLine);
      }
    }
  }

  return devDependencyLines;
};

/**
 * Checks if a version change is a downgrade (revert).
 *
 * @param oldVersion - The old version from the diff.
 * @param newVersion - The new version from the diff.
 * @returns True if this is a version downgrade, false otherwise.
 */
const isVersionDowngrade = (
  oldVersion: string,
  newVersion: string,
): boolean => {
  return new SemVer(newVersion).compare(new SemVer(oldVersion)) <= 0;
};

/**
 * Analyzes all changes in a package.json file and returns structured information.
 *
 * @param repoPath - The path to the repository.
 * @param filePath - The path to the package.json file.
 * @param baseRef - The base reference to compare against.
 * @returns Promise that resolves to an object with all change information.
 */
async function analyzePackageJsonChanges(
  repoPath: string,
  filePath: string,
  baseRef: string,
): Promise<{
  hasChanges: boolean;
  isVersionOnly: boolean;
  isDevDependencyOnly: boolean;
  isVersionAndDevDependencyOnly: boolean;
  isVersionDowngrade: boolean;
  newVersion: string | null;
}> {
  try {
    const { stdout } = await execa(
      'git',
      ['diff', '-U20', `origin/${baseRef}...HEAD`, '--', filePath],
      {
        cwd: repoPath,
      },
    );

    if (!stdout) {
      return {
        hasChanges: false,
        isVersionOnly: false,
        isDevDependencyOnly: false,
        isVersionAndDevDependencyOnly: false,
        isVersionDowngrade: false,
        newVersion: null,
      };
    }

    // Split the diff into lines and filter out the diff header lines (+++ and ---)
    const lines = stdout
      .split('\n')
      .filter((line) => line.startsWith('+') || line.startsWith('-'))
      .filter((line) => !line.startsWith('+++') && !line.startsWith('---'));

    if (lines.length === 0) {
      return {
        hasChanges: false,
        isVersionOnly: false,
        isDevDependencyOnly: false,
        isVersionAndDevDependencyOnly: false,
        isVersionDowngrade: false,
        newVersion: null,
      };
    }

    const versionLines: string[] = [];
    const nonVersionLines: string[] = [];

    for (const line of lines) {
      if (/^[+-]\s*"version":\s*"[^"]+"\s*,?\s*$/mu.test(line)) {
        versionLines.push(line);
      } else {
        nonVersionLines.push(line);
      }
    }

    // Check for version changes first
    const versionAddedLine = versionLines.find(
      (line) => line.startsWith('+') && line.includes('"version":'),
    );
    const versionAddedMatch = versionAddedLine?.match(
      /^\+\s*"version":\s*"([^"]+)"/u,
    );
    const newVersion = versionAddedMatch?.[1] ?? null;

    const versionRemovedLine = versionLines.find(
      (line) => line.startsWith('-') && line.includes('"version":'),
    );
    const versionRemovedMatch = versionRemovedLine?.match(
      /^-\s*"version":\s*"([^"]+)"/u,
    );
    const oldVersion = versionRemovedMatch?.[1] ?? null;

    const hasNewVersion = newVersion !== null;

    if (!hasNewVersion && oldVersion) {
      throw new Error(
        `Could not find new version for version change in ${filePath}`,
      );
    }

    const isDowngrade =
      oldVersion && newVersion
        ? isVersionDowngrade(oldVersion, newVersion)
        : false;

    // Check if only version was changed
    if (nonVersionLines.length === 0) {
      return {
        hasChanges: true,
        isVersionOnly: true,
        isDevDependencyOnly: false,
        isVersionAndDevDependencyOnly: false,
        isVersionDowngrade: isDowngrade,
        newVersion,
      };
    }

    // Check if all non-version lines are in devDependencies
    const devDependencyLines = getDevDependencyLines(stdout, nonVersionLines);
    const allNonVersionLinesAreDevDeps =
      devDependencyLines.length === nonVersionLines.length;

    return {
      hasChanges: true,
      isVersionOnly: false,
      isDevDependencyOnly: !hasNewVersion && allNonVersionLinesAreDevDeps,
      isVersionAndDevDependencyOnly:
        hasNewVersion && allNonVersionLinesAreDevDeps,
      isVersionDowngrade: isDowngrade,
      newVersion,
    };
  } catch (error) {
    logError(
      `Failed to analyze package.json changes in ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return {
      hasChanges: false,
      isVersionOnly: false,
      isDevDependencyOnly: false,
      isVersionAndDevDependencyOnly: false,
      isVersionDowngrade: false,
      newVersion: null,
    };
  }
}

/**
 * Checks if a package is marked as private in its package.json.
 *
 * @param repoPath - The path to the repository.
 * @param packageJsonPath - The path to the package.json file.
 * @returns Promise that resolves to true if the package is private, false otherwise.
 */
async function isPrivatePackage(
  repoPath: string,
  packageJsonPath: string,
): Promise<boolean> {
  try {
    const content = await fs.readFile(
      path.join(repoPath, packageJsonPath),
      'utf-8',
    );
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
 * @param packageVersion - The package version to check for release PRs.
 */
async function checkChangelogFile(
  changelogPath: string,
  prNumber: string,
  packageVersion?: string | null,
): Promise<void> {
  try {
    const changelogContent = await fs.readFile(changelogPath, 'utf-8');

    if (!changelogContent) {
      throw new Error('CHANGELOG.md is empty or missing');
    }

    const changelogData = parseChangelog({
      changelogContent,
      repoUrl: '', // Not needed as we're only parsing changes
    });

    // For release PRs with version changes, check the version section
    // Otherwise, check the Unreleased section
    let releaseSection = 'Unreleased';
    if (packageVersion) {
      const versionChanges = changelogData.getReleaseChanges(packageVersion);
      if (versionChanges && Object.keys(versionChanges).length > 0) {
        releaseSection = packageVersion;
      } else {
        throw new Error(
          `Could not find section for version '${packageVersion}' in changelog`,
        );
      }
    }

    const changelogChanges = changelogData.getReleaseChanges(releaseSection);

    if (
      !Object.values(changelogChanges)
        .flat()
        .some((entry) => entry.includes(`[#${prNumber}]`))
    ) {
      throw new Error(
        `There are changes made to this package that may not be reflected in the changelog ("${changelogPath}"). If the changes you've introduced are user-facing, please document them under the "${releaseSection}" section, making sure to link the entries to the current PR. If the changelog is up to date, you can bypass this check by adding the 'no-changelog' label to the PR.`,
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
    newVersion?: string | undefined;
  }[]
> {
  const changedPackages = new Map<
    string,
    { base: string; package: string; newVersion?: string | undefined }
  >();
  const privatePackageCache = new Map<string, boolean>();

  for (const file of files) {
    // Skip workflow files
    if (file.startsWith('.github/workflows/')) {
      continue;
    }

    const packageInfo = getPackageInfo(file, workspacePatterns);
    if (packageInfo) {
      let isPrivate = privatePackageCache.get(packageInfo.package);
      if (isPrivate === undefined) {
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
        let newVersion: string | undefined;

        if (file.endsWith('package.json')) {
          const packageJsonChanges = await analyzePackageJsonChanges(
            repoPath,
            file,
            baseRef,
          );

          if (!packageJsonChanges.hasChanges) {
            continue;
          }

          if (packageJsonChanges.isVersionOnly) {
            console.log(
              `Skipping package.json in ${packageInfo.package} as it only contains version changes`,
            );
            continue;
          }

          if (packageJsonChanges.isVersionDowngrade) {
            console.log(
              `Skipping package.json in ${packageInfo.package} as it contains a version downgrade (revert)`,
            );
            continue;
          }

          if (packageJsonChanges.isDevDependencyOnly) {
            console.log(
              `Skipping package.json in ${packageInfo.package} as it only contains dev dependency changes`,
            );
            continue;
          }

          if (packageJsonChanges.isVersionAndDevDependencyOnly) {
            console.log(
              `Skipping package.json in ${packageInfo.package} as it only contains version and dev dependency changes`,
            );
            continue;
          }

          if (packageJsonChanges.newVersion) {
            newVersion = packageJsonChanges.newVersion;
          }
        }

        const existingPackage = changedPackages.get(packageInfo.package);
        const packageData = {
          ...packageInfo,
          newVersion: existingPackage?.newVersion ?? newVersion,
        };
        changedPackages.set(packageInfo.package, packageData);
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
            pkgInfo.newVersion,
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
