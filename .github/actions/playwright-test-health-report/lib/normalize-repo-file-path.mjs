/**
 * Normalize a Playwright test path into a GitHub blob-friendly repo-relative path.
 *
 * Handles:
 * - CI absolute checkout paths (e.g. /Users/runner/work/.../tests/...)
 * - Optional testDir prefix (e.g. accounts/foo.spec.ts → tests/smoke-appium/accounts/foo.spec.ts)
 * - Idempotent when the path already starts with the prefix or `tests/`
 *
 * @param {string} filePath - The test file path to normalize.
 * @param {{ prefix?: string }} [options] - The options, where `prefix` is the test directory prepended to relative paths.
 * @returns {string} The normalized repo relative path.
 */
export function normalizeRepoFilePath(filePath, { prefix } = {}) {
  if (!filePath) {
    return filePath;
  }

  let normalized = String(filePath).replace(/\\/gu, '/');

  const isAbsolute =
    normalized.startsWith('/') || /^[A-Za-z]:\//u.test(normalized);
  if (isAbsolute) {
    const testsMatch = normalized.match(/(?:^|\/)(tests\/.+)$/u);
    if (testsMatch) {
      normalized = testsMatch[1];
    } else {
      const runnerMatch = normalized.match(/\/work\/[^/]+\/[^/]+\/(.+)$/u);
      if (runnerMatch) {
        normalized = runnerMatch[1];
      } else {
        normalized = normalized
          .replace(/^\/+/u, '')
          .replace(/^[A-Za-z]:\//u, '');
      }
    }
  }

  normalized = normalized.replace(/^\/+/u, '');

  const cleanPrefix = prefix
    ?.trim()
    .replace(/\\/gu, '/')
    .replace(/^\/+|\/+$/gu, '');
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
