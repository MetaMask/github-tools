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

// Must match the order auto-changelog writes categories in
// (`orderedChangeCategories` in packages/auto-changelog/src/constants.ts).
export const CATEGORY_ORDER = ['Uncategorized', ...CHANGE_CATEGORIES];

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
 * Finds the first line of every changelog entry in a section.
 *
 * @param section - A release section.
 * @returns The lines starting with `- `.
 */
export function getEntryLines(section: string): string[] {
  return section.match(/^- .+$/gmu) ?? [];
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
 * Rewrites this repository's long PR links in each entry's first line into the
 * short `(#123)` form, as auto-changelog does when it regenerates an entry.
 * Links to other repositories stay, because they are not this repository's PRs.
 *
 * @param section - The section text.
 * @param repositoryUrl - The repository's GitHub URL.
 * @returns The section with this repository's PR links shortened.
 */
export function normalizeRepositoryPrLinks(
  section: string,
  repositoryUrl: string,
): string {
  const repositoryName = new URL(repositoryUrl).pathname
    .split('/')
    .filter(Boolean)
    .pop()
    ?.replace(/\.git$/u, '');
  if (!repositoryName) {
    return section;
  }

  // Same shape as auto-changelog's: one group of long links, or legacy
  // adjacent groups separated by commas.
  const escapedName = repositoryName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const longGroup = `\\(\\s*(?:\\[#\\d+\\]\\([^)]*${escapedName}[^)]*\\)\\s*,?\\s*)+\\)`;
  const groups = new RegExp(`\\s+${longGroup}(?:\\s*,\\s*${longGroup})*`, 'gu');
  return section.replace(/^- .*$/gmu, (line) =>
    line.replace(groups, (group) => {
      const prNumbers = [...group.matchAll(/\[#(\d+)\]/gu)].flatMap(
        ([, prNumber]) => (prNumber ? [`#${prNumber}`] : []),
      );
      return ` (${prNumbers.join(', ')})`;
    }),
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

/**
 * Puts a release section into a changelog, replacing the release's existing
 * section or adding it above the newest release.
 *
 * @param options - Options.
 * @param options.changelog - The changelog contents.
 * @param options.currentReleaseSection - The section to write.
 * @param options.version - The release version.
 * @returns The updated changelog.
 */
export function mergeCurrentReleaseSection({
  changelog,
  currentReleaseSection,
  version,
}: {
  changelog: string;
  currentReleaseSection: string;
  version: string;
}): string {
  if (changelog.includes(releaseHeading(version))) {
    return replaceReleaseSection(changelog, version, currentReleaseSection);
  }

  if (!/^# Changelog\r?\n/u.test(changelog)) {
    throw new Error('CHANGELOG.md must begin with a Changelog heading');
  }

  // Releases follow the preamble and `## [Unreleased]`, newest first.
  const firstRelease = /^## \[(?!Unreleased\])/mu.exec(changelog);
  const lineEnding = detectLineEnding(changelog);
  const normalizedSection = currentReleaseSection.replace(
    /\r?\n/gu,
    lineEnding,
  );
  if (!firstRelease) {
    return `${changelog.trimEnd()}${lineEnding}${lineEnding}${normalizedSection}${lineEnding}`;
  }
  return `${changelog.slice(0, firstRelease.index)}${normalizedSection}${lineEnding}${lineEnding}${changelog.slice(firstRelease.index)}`;
}

type ReleaseSectionEntry = {
  lines: string[];
  prNumbers: string[];
};

type ReleaseSectionCategory = {
  heading: string;
  entries: ReleaseSectionEntry[];
};

/**
 * Splits a release section into its `###` categories and their entries,
 * including each entry's continuation lines.
 *
 * @param section - A release section.
 * @returns The categories in file order.
 * @throws If an entry has no category or the section has other content.
 */
function parseReleaseSectionCategories(
  section: string,
): ReleaseSectionCategory[] {
  const [, ...lines] = splitLines(section);
  const categories: ReleaseSectionCategory[] = [];
  let category: ReleaseSectionCategory | undefined;
  let entry: ReleaseSectionEntry | undefined;

  for (const line of lines) {
    if (line.startsWith('### ')) {
      category = { heading: line, entries: [] };
      categories.push(category);
      entry = undefined;
    } else if (line.startsWith('- ')) {
      if (!category) {
        throw new Error('Release entries must appear under a category heading');
      }
      entry = { lines: [line], prNumbers: getPrNumbers(line) };
      category.entries.push(entry);
    } else if (line !== '' && entry) {
      entry.lines.push(line);
      entry.prNumbers = getPrNumbers(entry.lines.join('\n'));
    } else if (line !== '') {
      throw new Error(`Unexpected release section content: ${line}`);
    }
  }

  return categories;
}

const PR_REFERENCE_PATTERN = /\(#(\d+)\)|#(\d+)/gu;

/**
 * Reads the PRs of an entry's owning reference group: the last group on its
 * first line, where the generator puts the entry's own PRs.
 *
 * @param firstLine - The entry's first line.
 * @returns The owning PR numbers, or none when the line has no group.
 */
function getOwningPrNumbers(firstLine: string): string[] {
  const [group] = [...firstLine.matchAll(PR_REFERENCE_GROUPS)].pop() ?? [];
  return [...(group ?? '').matchAll(/#(\d+)/gu)].flatMap(([, prNumber]) =>
    prNumber ? [prNumber] : [],
  );
}

/**
 * Rewrites an entry's PR references so only the owning group stays linked.
 * The generator appends the entry's own PRs last, as one group such as
 * `(#123, #124)`, so earlier references are prose.
 *
 * @param lines - The entry's lines.
 * @returns The lines with other references turned into plain `PR 123` text.
 */
function keepOnlyOwningReference(lines: string[]): string[] {
  const [firstLine = '', ...otherLines] = lines;
  const owningGroup = [...firstLine.matchAll(PR_REFERENCE_GROUPS)].pop();
  const keepStart = owningGroup?.index ?? 0;
  const keepEnd = keepStart + (owningGroup?.[0].length ?? 0);
  const demote = (text: string, isKept: (offset: number) => boolean): string =>
    text.replace(
      PR_REFERENCE_PATTERN,
      (match, parenthesized?: string, bare?: string, offset?: number) =>
        isKept(offset ?? -1) ? match : `PR ${parenthesized ?? bare ?? ''}`,
    );
  return [
    demote(firstLine, (offset) => offset >= keepStart && offset < keepEnd),
    ...otherLines.map((line) => demote(line, () => false)),
  ];
}

/**
 * Builds a section holding only the generated entries whose PR is not already
 * in the existing section. Entries copied unchanged from the existing section
 * are skipped first, so a reviewer's entry without a PR reference or with a
 * repeated one does not fail the run.
 *
 * @param options - Options.
 * @param options.existingSection - The release section to preserve.
 * @param options.generatedSection - The section auto-changelog generated.
 * @param options.version - The release version.
 * @param options.repositoryUrl - The repository's GitHub URL. Long links to it
 * in the existing section count as documented references.
 * @param options.deletedPrNumbers - PRs an earlier run already generated that
 * the existing section no longer lists, because a reviewer removed them.
 * @returns The new-entries section, or undefined when nothing is new.
 * @throws If a generated entry has no PR reference.
 */
export function getNewReleaseEntriesSection({
  existingSection,
  generatedSection,
  version,
  repositoryUrl,
  deletedPrNumbers,
}: {
  existingSection: string;
  generatedSection: string;
  version: string;
  repositoryUrl?: string;
  deletedPrNumbers?: ReadonlySet<string>;
}): string | undefined {
  const existing = repositoryUrl
    ? normalizeRepositoryPrLinks(existingSection, repositoryUrl)
    : existingSection;
  const existingPrNumbers = new Set(getPrNumbers(existing));
  const entryKey = (lines: string[]): string =>
    lines.map((line) => line.trimEnd()).join('\n');
  const existingEntries = new Set(
    parseReleaseSectionCategories(existing).flatMap(({ entries }) =>
      entries.map(({ lines }) => entryKey(lines)),
    ),
  );
  const categories = parseReleaseSectionCategories(generatedSection)
    .map(({ heading, entries }) => ({
      heading,
      entries: entries.flatMap(({ lines }) => {
        if (existingEntries.has(entryKey(lines))) {
          return [];
        }
        const owners = getOwningPrNumbers(lines[0] ?? '');
        if (owners.length === 0) {
          throw new Error('Generated release entry lacks a PR reference');
        }
        // A grouped entry covers all its PRs, so one documented PR means the
        // reviewer already has an entry for it.
        const isDocumented = owners.some(
          (owner) =>
            existingPrNumbers.has(owner) || deletedPrNumbers?.has(owner),
        );
        return isDocumented ? [] : [{ lines: keepOnlyOwningReference(lines) }];
      }),
    }))
    .filter(({ entries }) => entries.length > 0);

  if (categories.length === 0) {
    return undefined;
  }

  return [
    releaseHeading(version),
    ...categories.flatMap(({ heading, entries }) => [
      '',
      heading,
      '',
      ...entries.flatMap(({ lines }) => lines),
    ]),
  ].join('\n');
}

const CATEGORY_BY_LEADING_VERB = new Map([
  ['Added', '### Added'],
  ['Changed', '### Changed'],
  ['Updated', '### Changed'],
  ['Deprecated', '### Deprecated'],
  ['Removed', '### Removed'],
  ['Fixed', '### Fixed'],
]);

/**
 * Finds the category an entry's leading verb implies.
 *
 * @param entryLine - The entry's first line.
 * @returns The category heading, or undefined when the verb is not a known one.
 */
function getCategoryImpliedByWording(entryLine: string): string | undefined {
  const [, verb] = /^- (\w+)\b/u.exec(entryLine) ?? [];
  return verb ? CATEGORY_BY_LEADING_VERB.get(verb) : undefined;
}

/**
 * Files each AI-cleaned entry under the category its wording implies, so an
 * entry reworded to "Fixed ..." is not left under Removed. Other entries go
 * back under the category the generator chose, so proofreading cannot
 * recategorize a PR. Entries that merge PRs from different generated
 * categories, or that the generator left Uncategorized, keep the proofreader's
 * category.
 *
 * @param options - Options.
 * @param options.generatedSection - The new-entries section before proofreading.
 * @param options.cleanedSection - The same section after proofreading.
 * @param options.version - The release version.
 * @returns The cleaned section with generator categories restored.
 */
export function restoreGeneratedCategories({
  generatedSection,
  cleanedSection,
  version,
}: {
  generatedSection: string;
  cleanedSection: string;
  version: string;
}): string {
  const generatedCategoryByPr = new Map<string, string>();
  for (const { heading, entries } of parseReleaseSectionCategories(
    generatedSection,
  )) {
    for (const entry of entries) {
      for (const prNumber of entry.prNumbers) {
        generatedCategoryByPr.set(prNumber, heading);
      }
    }
  }

  const buckets = new Map<string, string[]>();
  const order: string[] = [];
  for (const { heading, entries } of parseReleaseSectionCategories(
    cleanedSection,
  )) {
    for (const entry of entries) {
      const generatedHeadings = new Set(
        entry.prNumbers.map((prNumber) => generatedCategoryByPr.get(prNumber)),
      );
      const [only] = [...generatedHeadings];
      const target =
        getCategoryImpliedByWording(entry.lines[0] ?? '') ??
        (generatedHeadings.size === 1 &&
        only !== undefined &&
        only !== '### Uncategorized'
          ? only
          : heading);
      if (!buckets.has(target)) {
        buckets.set(target, []);
        order.push(target);
      }
      buckets.get(target)?.push(...entry.lines);
    }
  }

  return [
    releaseHeading(version),
    ...order
      .sort((left, right) => getCategoryRank(left) - getCategoryRank(right))
      .flatMap((heading) => ['', heading, '', ...(buckets.get(heading) ?? [])]),
  ].join('\n');
}

/**
 * Ranks a `### Category` heading by auto-changelog's category order.
 *
 * @param heading - The category heading line.
 * @returns The position, or past the end for an unknown category.
 */
function getCategoryRank(heading: string): number {
  const rank = CATEGORY_ORDER.indexOf(heading.slice('### '.length));
  return rank === -1 ? CATEGORY_ORDER.length : rank;
}

/**
 * Merges newly generated entries into an existing release section. Existing
 * lines are never modified. New entries go at the top of a matching category,
 * as auto-changelog does, and a missing category is inserted in canonical
 * order.
 *
 * @param options - Options.
 * @param options.existingSection - The release section to preserve.
 * @param options.newEntriesSection - A release section holding only new entries.
 * @param options.version - The release version.
 * @returns The merged release section.
 */
export function mergeNewReleaseEntries({
  existingSection,
  newEntriesSection,
  version,
}: {
  existingSection: string;
  newEntriesSection: string;
  version: string;
}): string {
  const heading = releaseHeading(version);
  if (!newEntriesSection.startsWith(heading)) {
    throw new Error(`Expected new entries section to begin with ${heading}`);
  }

  const lineEnding = detectLineEnding(existingSection);
  const lines = splitLines(existingSection.trimEnd());

  for (const {
    heading: categoryHeading,
    entries,
  } of parseReleaseSectionCategories(newEntriesSection)) {
    const entryLines = entries.flatMap((entry) => entry.lines);
    if (entryLines.length === 0) {
      continue;
    }

    const headingIndex = lines.indexOf(categoryHeading);
    if (headingIndex !== -1) {
      // Skip the blank line(s) after the heading so entries lead the list.
      let insertAt = headingIndex + 1;
      while (insertAt < lines.length && lines[insertAt] === '') {
        insertAt += 1;
      }
      const isEmptyCategory =
        insertAt >= lines.length || lines[insertAt]?.startsWith('### ');
      lines.splice(
        insertAt,
        0,
        ...(insertAt === headingIndex + 1 ? [''] : []),
        ...entryLines,
        ...(isEmptyCategory && insertAt < lines.length ? [''] : []),
      );
      continue;
    }

    const rank = getCategoryRank(categoryHeading);
    const nextCategoryIndex = lines.findIndex(
      (line) => line.startsWith('### ') && getCategoryRank(line) > rank,
    );
    if (nextCategoryIndex === -1) {
      lines.push('', categoryHeading, '', ...entryLines);
    } else {
      lines.splice(
        nextCategoryIndex,
        0,
        categoryHeading,
        '',
        ...entryLines,
        '',
      );
    }
  }

  return lines.join(lineEnding);
}
