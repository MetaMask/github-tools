/*
 * Restores a finalized release's changelog history after `git merge -s ours`.
 *
 * `merge-previous-releases.sh` merges the previous release branch with the
 * `ours` strategy, which records the ancestry but keeps the destination's
 * files, so the finalized `## [version]` section and its `[version]: url` link
 * reference from the source's CHANGELOG.md would be lost. This script copies
 * them back in version order.
 *
 * Usage: node merge-previous-release-changelog.mts <source-ref> <version>
 *
 * The changelog is edited as plain text, not through a changelog parser, so
 * anything this script doesn't fully understand is left untouched. Every
 * ambiguous or failing case warns and exits successfully, preserving the
 * destination: a wrong automated edit to release history is worse than a
 * missing one that a reviewer can add by hand.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

import {
  detectLineEnding,
  extractReleaseSection,
  getReleaseVersions,
  hasSingleReleaseHeading,
  LINK_REFERENCE,
} from './release-section.mts';
import { compareSemver } from './release-version-utils.mts';

/**
 * Finds the `[version]: url` link reference for a release.
 * @param changelog - The changelog contents.
 * @param version - The release version.
 * @returns The reference line, or undefined when missing or ambiguous.
 */
function getReleaseReference(
  changelog: string,
  version: string,
): string | undefined {
  const matches = [
    ...changelog.matchAll(
      new RegExp(`^\\[${version.replaceAll('.', '\\.')}\\]: .+$`, 'gmu'),
    ),
  ];
  return matches.length === 1 ? matches[0]?.[0] : undefined;
}

/**
 * Finds where a version belongs in descending version order.
 * @param changelog - The changelog contents.
 * @param version - The version being inserted.
 * @param pattern - A global regex whose first group captures a version.
 * @returns The index of the first older entry, or undefined if none.
 */
function findInsertionIndex(
  changelog: string,
  version: string,
  pattern: RegExp,
): number | undefined {
  // Entries are newest-first, so the first older entry marks the insert point.
  for (const match of changelog.matchAll(pattern)) {
    const candidate = match[1];
    if (
      candidate &&
      match.index !== undefined &&
      compareSemver(version, candidate) > 0
    ) {
      return match.index;
    }
  }
  return undefined;
}

/**
 * Inserts a release section in version order.
 * @param changelog - The destination changelog contents.
 * @param section - The section to insert.
 * @param version - The release version.
 * @param lineEnding - The destination's line ending.
 * @returns The updated changelog.
 */
function insertReleaseSection(
  changelog: string,
  section: string,
  version: string,
  lineEnding: string,
): string {
  const index = findInsertionIndex(
    changelog,
    version,
    /^## \[(\d+\.\d+\.\d+)\]$/gmu,
  );
  // `git show` returns committed (LF) text, which can differ from the checkout.
  const normalizedSection = section.replaceAll('\n', lineEnding);

  // Nothing older exists, so the section goes last, above the link references.
  if (index === undefined) {
    const referencesIndex = changelog.search(LINK_REFERENCE);
    const beforeReferences =
      referencesIndex === -1 ? changelog.length : referencesIndex;
    return `${changelog.slice(0, beforeReferences).trimEnd()}${lineEnding}${lineEnding}${normalizedSection}${lineEnding}${lineEnding}${changelog.slice(beforeReferences)}`;
  }

  return `${changelog.slice(0, index)}${normalizedSection}${lineEnding}${lineEnding}${changelog.slice(index)}`;
}

/**
 * Inserts a release link reference in version order, if not already present.
 * @param changelog - The destination changelog contents.
 * @param reference - The reference line to insert.
 * @param version - The release version.
 * @param lineEnding - The destination's line ending.
 * @returns The updated changelog.
 */
function insertReleaseReference(
  changelog: string,
  reference: string | undefined,
  version: string,
  lineEnding: string,
): string {
  // Skip when the source has no reference, or when one already exists so the
  // destination's own link wins.
  if (!reference || getReleaseReference(changelog, version)) {
    return changelog;
  }

  const index = findInsertionIndex(
    changelog,
    version,
    /^\[(\d+\.\d+\.\d+)\]: /gmu,
  );
  if (index === undefined) {
    return `${changelog.trimEnd()}${lineEnding}${reference}${lineEnding}`;
  }
  return `${changelog.slice(0, index)}${reference}${lineEnding}${changelog.slice(index)}`;
}

/**
 * Copies a finalized release section from a source branch's changelog into
 * the destination changelog, preserving the destination on any ambiguity.
 */
function main(): void {
  const [sourceRef, version] = process.argv.slice(2);
  if (!sourceRef || !version) {
    throw new Error(
      'Usage: merge-previous-release-changelog.mts <source-ref> <version>',
    );
  }

  const destination = readFileSync('CHANGELOG.md', 'utf8');
  // Mobile's changelog is larger than the 1 MiB default buffer.
  const source = execFileSync('git', ['show', `${sourceRef}:CHANGELOG.md`], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const section = hasSingleReleaseHeading(source, version)
    ? extractReleaseSection(source, version).section
    : undefined;

  // Only a finalized release has a versioned section; an unreleased or
  // duplicated one is not safe to copy.
  if (!section) {
    console.warn(
      `Source changelog has no unambiguous finalized ${version} section; preserving destination changelog.`,
    );
    return;
  }
  // The destination already records this release, so there is nothing to
  // restore and inserting would duplicate the heading.
  if (getReleaseVersions(destination).includes(version)) {
    console.warn(
      `Destination already has a ${version} section; preserving destination changelog.`,
    );
    return;
  }

  // Match the destination so the diff doesn't rewrite every line ending.
  const lineEnding = detectLineEnding(destination);
  const withSection = insertReleaseSection(
    destination,
    section,
    version,
    lineEnding,
  );
  const merged = insertReleaseReference(
    withSection,
    getReleaseReference(source, version),
    version,
    lineEnding,
  );
  writeFileSync('CHANGELOG.md', merged);
  console.log(
    `Inserted finalized ${version} changelog history from ${sourceRef}.`,
  );
}

// Never fail the release merge over changelog history; see the header comment.
try {
  main();
} catch (error) {
  console.warn(
    `Unable to merge source changelog history; preserving destination changelog: ${error instanceof Error ? error.message : String(error)}`,
  );
}
