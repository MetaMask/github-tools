import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

function compareVersions(left, right) {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);

  for (let index = 0; index < leftParts.length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function getReleaseHeadingMatches(changelog, version) {
  const heading = `## [${version}]`;
  return [
    ...changelog.matchAll(new RegExp(`^${escapeRegex(heading)}$`, 'gmu')),
  ];
}

function getReleaseSection(changelog, version) {
  const heading = `## [${version}]`;
  const matches = getReleaseHeadingMatches(changelog, version);
  if (matches.length !== 1 || matches[0]?.index === undefined) {
    return undefined;
  }

  const start = matches[0].index;
  const nextHeading = changelog.indexOf('\n## [', start + heading.length);
  const end = nextHeading === -1 ? changelog.length : nextHeading + 1;
  return changelog.slice(start, end).trimEnd();
}

function getReleaseReference(changelog, version) {
  const matches = [
    ...changelog.matchAll(
      new RegExp(`^\\[${escapeRegex(version)}\\]: .+$`, 'gmu'),
    ),
  ];
  return matches.length === 1 ? matches[0]?.[0] : undefined;
}

function findInsertionIndex(changelog, version, pattern) {
  for (const match of changelog.matchAll(pattern)) {
    const candidate = match[1];
    if (
      candidate &&
      match.index !== undefined &&
      compareVersions(version, candidate) > 0
    ) {
      return match.index;
    }
  }
  return undefined;
}

function insertReleaseSection(changelog, section, version, lineEnding) {
  const index = findInsertionIndex(
    changelog,
    version,
    /^## \[(\d+\.\d+\.\d+)\]$/gmu,
  );
  const normalizedSection = section.replaceAll('\n', lineEnding);

  if (index === undefined) {
    const referencesIndex = changelog.search(/^\[\d+\.\d+\.\d+\]: /mu);
    const beforeReferences =
      referencesIndex === -1 ? changelog.length : referencesIndex;
    return `${changelog.slice(0, beforeReferences).trimEnd()}${lineEnding}${lineEnding}${normalizedSection}${lineEnding}${lineEnding}${changelog.slice(beforeReferences)}`;
  }

  return `${changelog.slice(0, index)}${normalizedSection}${lineEnding}${lineEnding}${changelog.slice(index)}`;
}

function insertReleaseReference(changelog, reference, version, lineEnding) {
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

function main() {
  const [sourceRef, version] = process.argv.slice(2);
  if (!sourceRef || !version) {
    throw new Error(
      'Usage: merge-previous-release-changelog.mjs <source-ref> <version>',
    );
  }

  const destination = readFileSync('CHANGELOG.md', 'utf8');
  const source = execFileSync('git', ['show', `${sourceRef}:CHANGELOG.md`], {
    encoding: 'utf8',
  });
  const section = getReleaseSection(source, version);

  if (!section) {
    console.warn(
      `Source changelog has no unambiguous finalized ${version} section; preserving destination changelog.`,
    );
    return;
  }
  if (getReleaseHeadingMatches(destination, version).length > 0) {
    console.warn(
      `Destination already has a ${version} section; preserving destination changelog.`,
    );
    return;
  }

  const lineEnding = destination.includes('\r\n') ? '\r\n' : '\n';
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

try {
  main();
} catch (error) {
  console.warn(
    `Unable to merge source changelog history; preserving destination changelog: ${error instanceof Error ? error.message : String(error)}`,
  );
}
