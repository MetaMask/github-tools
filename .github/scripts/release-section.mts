// Pure helpers for reading and editing a `## [VERSION]` changelog section.
// Nothing here touches the filesystem, Git, or the network.

export const CHANGE_CATEGORIES = [
  'Added',
  'Changed',
  'Deprecated',
  'Removed',
  'Fixed',
  'Security',
] as const;

export type ReleaseSection = {
  section: string;
  start: number;
  end: number;
};

// Any `[label]: url` line, including `[Unreleased]: url`.
export const LINK_REFERENCE = /^\[[^\]]+\]: /mu;

// A release section ends at the next heading or at the link references.
const SECTION_END = /^(?:## \[|\[[^\]]+\]: )/mu;

/**
 * Builds the `## [version]` heading line.
 *
 * @param version - The release version.
 * @returns The heading.
 */
export function releaseHeading(version: string): string {
  return `## [${version}]`;
}

/**
 * Builds a global regex matching a release's heading line.
 *
 * @param version - The release version.
 * @returns The pattern.
 */
function releaseHeadingPattern(version: string): RegExp {
  return new RegExp(`^## \\[${version.replaceAll('.', '\\.')}\\]$`, 'gmu');
}

/**
 * Checks that a release's heading appears exactly once.
 *
 * @param content - The changelog contents.
 * @param version - The release version.
 * @returns True when there is exactly one matching heading.
 */
export function hasSingleReleaseHeading(
  content: string,
  version: string,
): boolean {
  return content.match(releaseHeadingPattern(version))?.length === 1;
}

/**
 * Reads the version out of a release heading line.
 *
 * @param line - A single line.
 * @returns The version, or undefined when the line is not a release heading.
 */
export function parseReleaseHeadingVersion(line: string): string | undefined {
  return /^## \[(\d+\.\d+\.\d+)\]$/u.exec(line)?.[1];
}

/**
 * Lists every released version heading, in file order.
 *
 * @param content - The changelog contents.
 * @returns The versions. `Unreleased` is not included.
 */
export function getReleaseVersions(content: string): string[] {
  return splitLines(content).flatMap((line) => {
    const version = parseReleaseHeadingVersion(line);
    return version ? [version] : [];
  });
}

/**
 * Detects whether text uses CRLF or LF line endings.
 *
 * @param text - The text to inspect.
 * @returns CRLF if the text contains any, otherwise LF.
 */
export function detectLineEnding(text: string): '\r\n' | '\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * Splits text into lines regardless of line ending.
 *
 * @param text - The text to split.
 * @returns The lines, without line endings.
 */
export function splitLines(text: string): string[] {
  return text.split(/\r?\n/u);
}

/**
 * Finds a release's section and where it sits in the changelog.
 *
 * @param content - The changelog contents.
 * @param version - The release version.
 * @returns The section text and its start and end offsets.
 * @throws If the release heading is missing or duplicated.
 */
export function extractReleaseSection(
  content: string,
  version: string,
): ReleaseSection {
  const heading = releaseHeading(version);
  const matches = [...content.matchAll(releaseHeadingPattern(version))];
  const start = matches[0]?.index;
  if (matches.length !== 1 || start === undefined) {
    throw new Error(`Expected exactly one release heading for ${version}`);
  }

  const bodyStart = start + heading.length;
  const bodyEnd = content.slice(bodyStart).search(SECTION_END);
  const section = content
    .slice(start, bodyEnd === -1 ? undefined : bodyStart + bodyEnd)
    .trimEnd();

  return {
    section,
    start,
    end: start + section.length,
  };
}

/**
 * Replaces a release's section in place.
 *
 * @param content - The changelog contents.
 * @param version - The release version.
 * @param replacement - The new section text, with any line endings.
 * @returns The updated changelog, with the replacement in its line endings.
 */
export function replaceReleaseSection(
  content: string,
  version: string,
  replacement: string,
): string {
  const { start, end } = extractReleaseSection(content, version);
  const normalized = replacement.replace(/\r?\n/gu, detectLineEnding(content));
  return `${content.slice(0, start)}${normalized}${content.slice(end)}`;
}

// Mirrors auto-changelog's parser, which reads these groups from an entry's
// first line: `(#123)`, `(#123, #124)`, and the legacy `(#123), (#124)`.
const PR_REFERENCE_GROUPS = /\s+(?:\(#\d+(?:\s*,\s*#\d+)*\)\s*,?\s*)+/gu;

/**
 * Reads the PR numbers in an entry the way auto-changelog does. Other `#123`
 * text, such as an issue number, is not a PR reference.
 *
 * @param entry - One changelog entry.
 * @returns The PR numbers, in order, or none when the first line has no reference group.
 */
export function getEntryPrNumbers(entry: string): string[] {
  const firstLine = splitLines(entry)[0] ?? '';
  return [...firstLine.matchAll(PR_REFERENCE_GROUPS)].flatMap(([group]) =>
    [...group.matchAll(/#(\d+)/gu)].flatMap(([, prNumber]) =>
      prNumber ? [prNumber] : [],
    ),
  );
}

/**
 * Collects the PR numbers of every entry in a section.
 *
 * @param section - The section text.
 * @returns The PR numbers, as strings, in order of appearance.
 */
export function getPrNumbers(section: string): string[] {
  const entries: string[][] = [];
  let currentEntry: string[] | undefined;
  for (const line of splitLines(section)) {
    if (line.startsWith('- ')) {
      currentEntry = [line];
      entries.push(currentEntry);
    } else if (line.startsWith('## ') || line.startsWith('### ')) {
      currentEntry = undefined;
    } else if (currentEntry && line !== '') {
      currentEntry.push(line);
    }
  }
  return entries.flatMap((entry) => getEntryPrNumbers(entry.join('\n')));
}
