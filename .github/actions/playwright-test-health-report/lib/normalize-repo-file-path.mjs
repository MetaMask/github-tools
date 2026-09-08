/**
 * Normalize a Playwright test path into a GitHub blob-friendly repo-relative path.
 *
 * Handles:
 * - CI absolute checkout paths (e.g. /Users/runner/work/.../tests/...)
 * - Optional testDir prefix (e.g. accounts/foo.spec.ts → tests/smoke-appium/accounts/foo.spec.ts)
 * - Idempotent when the path already starts with the prefix or `tests/`
 *
 * @param {string} filePath
 * @param {{ prefix?: string }} [options]
 * @returns {string}
 */
export function normalizeRepoFilePath(filePath, { prefix } = {}) {
  if (!filePath) {
    return filePath;
  }

  let normalized = String(filePath).replace(/\\/g, '/');

  const isAbsolute = normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized);
  if (isAbsolute) {
    const testsMatch = normalized.match(/(?:^|\/)(tests\/.+)$/);
    if (testsMatch) {
      normalized = testsMatch[1];
    } else {
      const runnerMatch = normalized.match(/\/work\/[^/]+\/[^/]+\/(.+)$/);
      if (runnerMatch) {
        normalized = runnerMatch[1];
      } else {
        normalized = normalized.replace(/^\/+/, '').replace(/^[A-Za-z]:\//, '');
      }
    }
  }

  normalized = normalized.replace(/^\/+/, '');

  const cleanPrefix = prefix?.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (cleanPrefix) {
    const alreadyPrefixed =
      normalized === cleanPrefix ||
      normalized.startsWith(`${cleanPrefix}/`) ||
      normalized.startsWith('tests/');
    if (!alreadyPrefixed) {
      normalized = `${cleanPrefix}/${normalized}`;
    }
  }

  return normalized;
}
