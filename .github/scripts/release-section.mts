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

export function releaseHeading(version: string): string {
  return `## [${version}]`;
}

function releaseHeadingPattern(version: string): RegExp {
  return new RegExp(`^## \\[${version.replaceAll('.', '\\.')}\\]$`, 'gmu');
}

export function hasSingleReleaseHeading(
  content: string,
  version: string,
): boolean {
  return content.match(releaseHeadingPattern(version))?.length === 1;
}

export function parseReleaseHeadingVersion(line: string): string | undefined {
  return /^## \[(\d+\.\d+\.\d+)\]$/u.exec(line)?.[1];
}

export function getReleaseVersions(content: string): string[] {
  return splitLines(content).flatMap((line) => {
    const version = parseReleaseHeadingVersion(line);
    return version ? [version] : [];
  });
}

export function detectLineEnding(text: string): '\r\n' | '\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

export function splitLines(text: string): string[] {
  return text.split(/\r?\n/u);
}

export function getEntryLines(section: string): string[] {
  return section.match(/^- .+$/gmu) ?? [];
}

export function extractReleaseSection(
  content: string,
  version: string,
): ReleaseSection {
  const heading = releaseHeading(version);
  if (!hasSingleReleaseHeading(content, version)) {
    throw new Error(`Expected exactly one release heading for ${version}`);
  }

  const start = content.indexOf(heading);
  const nextHeading = content.indexOf('\n## [', start + heading.length);
  const rawEnd = nextHeading === -1 ? content.length : nextHeading + 1;
  const section = content.slice(start, rawEnd).trimEnd();

  return {
    section,
    start,
    end: start + section.length,
  };
}

export function replaceReleaseSection(
  content: string,
  version: string,
  replacement: string,
): string {
  const { start, end } = extractReleaseSection(content, version);
  return `${content.slice(0, start)}${replacement}${content.slice(end)}`;
}

export function getPrNumbers(section: string): string[] {
  return [...section.matchAll(/#(\d+)/gu)].flatMap((match) => {
    const prNumber = match[1];
    return prNumber ? [prNumber] : [];
  });
}

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
  const normalizedSection = currentReleaseSection.replaceAll('\n', lineEnding);
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

// The generator appends the entry's own PR last, so earlier refs are prose.
function keepOnlyOwningReference(lines: string[]): string[] {
  const [firstLine = '', ...otherLines] = lines;
  const lastMatch = [...firstLine.matchAll(PR_REFERENCE_PATTERN)].pop();
  const demote = (text: string, keepOffset?: number): string =>
    text.replace(
      PR_REFERENCE_PATTERN,
      (match, parenthesized?: string, bare?: string, offset?: number) =>
        offset === keepOffset ? match : `PR ${parenthesized ?? bare ?? ''}`,
    );
  return [
    demote(firstLine, lastMatch?.index),
    ...otherLines.map((line) => demote(line)),
  ];
}

export function getNewReleaseEntriesSection({
  existingSection,
  generatedSection,
  version,
}: {
  existingSection: string;
  generatedSection: string;
  version: string;
}): string | undefined {
  const existingPrNumbers = new Set(getPrNumbers(existingSection));
  const categories = parseReleaseSectionCategories(generatedSection)
    .map(({ heading, entries }) => ({
      heading,
      entries: entries.flatMap(({ lines }) => {
        const [owner] = getPrNumbers(lines[0] ?? '').slice(-1);
        if (owner === undefined) {
          throw new Error('Generated release entry lacks a PR reference');
        }
        return existingPrNumbers.has(owner)
          ? []
          : [{ lines: keepOnlyOwningReference(lines) }];
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

/**
 * Puts each AI-cleaned entry back under the category the generator chose, so
 * proofreading cannot recategorize a PR. Entries that merge PRs from different
 * generated categories, or that the generator left Uncategorized, keep the
 * proofreader's category.
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
        generatedHeadings.size === 1 &&
        only !== undefined &&
        only !== '### Uncategorized'
          ? only
          : heading;
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
