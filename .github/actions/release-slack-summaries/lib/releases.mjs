/**
 * Active releases: open pull requests whose head ref is `release/X.Y.Z` and
 * whose base is `stable`.
 *
 * Version sort is `compareVersions` from
 * `helpers/list-release-versions/scripts/release-versions-extraction.js`.
 * The five-release cap is `.slice(-5)` after that ascending sort (MCRM-155
 * §5.2): the Zapier loop's "maximum 5" lived outside the script, which has
 * the sort but not the slice. Keeping the newest five matches the proposal.
 * Release validation also keeps `version.endsWith(".0")` (Zap 597
 * `bug-report-filtering.js`).
 */

const RELEASE_HEAD = /^release\/(\d+\.\d+\.\d+)$/u;

/**
 * Compares dotted numeric versions, oldest first.
 *
 * @param {{ version: string }} left - Versioned record.
 * @param {{ version: string }} right - Versioned record.
 * @returns {number} Sort comparator, oldest first.
 */
export function compareVersions(left, right) {
  const aParts = left.version.split('.').map(Number);
  const bParts = right.version.split('.').map(Number);

  for (let index = 0; index < aParts.length; index += 1) {
    if (aParts[index] !== bParts[index]) {
      return aParts[index] - bParts[index];
    }
  }

  return 0;
}

/**
 * Selects the newest open release pull requests for this mode.
 *
 * @param {object[]} pulls - GitHub pull request objects.
 * @param {object} options - Selection options.
 * @param {'blocker-summary' | 'release-validation'} options.mode - Which Zap to cap for.
 * @param {number} [options.limit] - Cap after the version sort. Default 5.
 * @returns {object[]} Selected pull requests, oldest first, each with `version`.
 */
export function selectReleases(pulls, { mode, limit = 5 } = {}) {
  const matched = pulls
    .filter((pull) => (pull.state ? pull.state === 'open' : true))
    .filter((pull) => (pull.base?.ref ? pull.base.ref === 'stable' : true))
    .map((pull) => {
      const match = pull.head?.ref?.match(RELEASE_HEAD);
      if (!match) {
        return null;
      }
      return { ...pull, version: match[1] };
    })
    .filter((pull) => pull !== null);

  matched.sort(compareVersions);
  const versionFiltered =
    mode === 'release-validation'
      ? matched.filter((pull) => pull.version.endsWith('.0'))
      : matched;
  return versionFiltered.slice(-limit);
}
