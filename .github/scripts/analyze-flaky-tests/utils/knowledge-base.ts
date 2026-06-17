import fs from 'fs';
import path from 'path';

const KNOWLEDGE_PATH = path.join(
  __dirname,
  '..',
  'knowledge',
  'extension-flakiness-patterns.md',
);

let cachedContent: string | null = null;

function loadKnowledgeBase(): string {
  if (cachedContent !== null) return cachedContent;
  try {
    cachedContent = fs.readFileSync(KNOWLEDGE_PATH, 'utf-8');
    return cachedContent;
  } catch {
    console.error('Warning: Could not load extension-flakiness-patterns.md');
    cachedContent = '';
    return '';
  }
}

/**
 * Returns all available section names (## and ### headings) from the knowledge base.
 */
export function listKnowledgeSections(): string[] {
  const content = loadKnowledgeBase();
  const headingRegex = /^#{2,3}\s+(.+)$/gm;
  const sections: string[] = [];
  let match;
  while ((match = headingRegex.exec(content)) !== null) {
    if (match[1]) sections.push(match[1]);
  }
  return sections;
}

/**
 * Searches the knowledge base for a section matching the given category keyword.
 * Matches against ## headers and returns the full section content up to the next ## header.
 */
export function getKnowledgeSection(category: string): string {
  const content = loadKnowledgeBase();
  if (!content) return 'Knowledge base not available.';

  const normalizedQuery = category.toLowerCase().replace(/[_-]/g, ' ');

  const sectionRegex = /^## (.+)$/gm;
  const sectionStarts: Array<{ title: string; index: number }> = [];
  let match;
  while ((match = sectionRegex.exec(content)) !== null) {
    if (match[1]) {
      sectionStarts.push({ title: match[1], index: match.index });
    }
  }

  const matched = sectionStarts.find((s) =>
    s.title.toLowerCase().replace(/[_-]/g, ' ').includes(normalizedQuery),
  );

  if (!matched) {
    const allTitles = sectionStarts.map((s) => s.title).join(', ');
    return `No section matching "${category}" found. Available sections: ${allTitles}`;
  }

  const matchedIdx = sectionStarts.indexOf(matched);
  const nextSection = sectionStarts[matchedIdx + 1];
  const sectionEnd = nextSection ? nextSection.index : content.length;
  return content.substring(matched.index, sectionEnd).trim();
}
