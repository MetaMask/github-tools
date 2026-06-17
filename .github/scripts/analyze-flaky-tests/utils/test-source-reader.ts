import path from 'path';
import type { Octokit } from '@octokit/rest';
import type { TestSourceContext } from '../types';

const MAX_SEARCH_RESULTS = 20;

export async function searchTestFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  query: string,
): Promise<string[]> {
  const { data: tree } = await octokit.rest.git.getTree({
    owner,
    repo,
    tree_sha: 'main',
    recursive: '1',
  });

  const keywords = query.toLowerCase().split(/\s+/);
  return tree.tree
    .filter((item) => {
      if (item.type !== 'blob' || !item.path) return false;
      const p = item.path.toLowerCase();
      if (!p.includes('test/e2e/')) return false;
      return keywords.every((kw) => p.includes(kw));
    })
    .map((item) => item.path!)
    .slice(0, MAX_SEARCH_RESULTS);
}

export async function fetchFileContent(
  octokit: Octokit,
  owner: string,
  repo: string,
  filePath: string,
  ref = 'main',
): Promise<string | null> {
  try {
    const response = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: filePath,
      ref,
    });

    if ('content' in response.data && typeof response.data.content === 'string') {
      return Buffer.from(response.data.content, 'base64').toString('utf-8');
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Parses import statements from a test file to discover page object and flow
 * dependencies. Returns resolved paths relative to the repo root.
 */
function parseImportedPageObjects(
  testFileContent: string,
  testFilePath: string,
): string[] {
  const importRegex = /from\s+['"]([^'"]+)['"]/g;
  const pageObjectPaths: string[] = [];
  const testDir = path.dirname(testFilePath);

  let match;
  while ((match = importRegex.exec(testFileContent)) !== null) {
    const importPath = match[1];
    if (!importPath) continue;

    const isPageObjectOrFlow =
      importPath.includes('page-objects') ||
      importPath.includes('pages/') ||
      importPath.includes('flows/');

    if (importPath.startsWith('.') && isPageObjectOrFlow) {
      let resolved = path.posix.join(testDir, importPath);
      if (!resolved.endsWith('.ts') && !resolved.endsWith('.js')) {
        resolved += '.ts';
      }
      pageObjectPaths.push(resolved);
    }
  }

  return pageObjectPaths;
}

export async function fetchTestSource(
  octokit: Octokit,
  testFilePath: string,
  owner: string,
  repo: string,
  ref = 'main',
): Promise<TestSourceContext> {
  const testFileContent = await fetchFileContent(octokit, owner, repo, testFilePath, ref);

  if (!testFileContent) {
    return {
      testFileContent: `Could not fetch test file: ${testFilePath}`,
      testFilePath,
      pageObjects: [],
    };
  }

  const pageObjectPaths = parseImportedPageObjects(testFileContent, testFilePath);
  const pageObjects: TestSourceContext['pageObjects'] = [];

  const fetches = pageObjectPaths.map(async (poPath) => {
    const content = await fetchFileContent(octokit, owner, repo, poPath, ref);
    if (content) {
      pageObjects.push({ path: poPath, content });
    }
  });

  await Promise.all(fetches);

  return {
    testFileContent,
    testFilePath,
    pageObjects,
  };
}
