/**
 * Turns Jira issues into the bug shape Zap 596/597 crafting already expects.
 * MCRM-155 §5.4. This is the only new mapping; message text stays in the craft
 * modules.
 */

const RELEASE_BLOCKER_LABEL = 'release-blocker';

/**
 * Maps one Jira issue into the Zap bug shape.
 *
 * @param {object} issue - Jira issue from `/rest/api/3/search/jql`.
 * @param {object} options - Mapping options.
 * @param {string | undefined} options.teamLabel - Topology label for `project.key`, if any.
 * @param {boolean} options.inBlockersSet - Whether this key was returned by the blocker search.
 * @param {string} options.browseBaseUrl - Jira site origin.
 * @returns {object} Zap bug. `closed` is the string `"true"` or `"false"`.
 */
export function jiraIssueToRcBug(
  issue,
  { teamLabel, inBlockersSet, browseBaseUrl },
) {
  const fields = issue.fields ?? {};
  const projectKey = fields.project?.key;
  const statusCategoryKey = fields.status?.statusCategory?.key;
  const base = browseBaseUrl.replace(/\/$/u, '');
  const labels = [
    teamLabel,
    inBlockersSet ? RELEASE_BLOCKER_LABEL : undefined,
  ].filter(Boolean);

  return {
    key: issue.key,
    // Kept off `labels` so an unmapped project key cannot collide with a
    // topology label. Zap 597 reads it only for the registry fallback line.
    projectKey: projectKey || '',
    name: fields.summary,
    url: `${base}/browse/${issue.key}`,
    closed: String(statusCategoryKey === 'done'),
    assigneesLength: fields.assignee ? 1 : 0,
    labels,
  };
}

/**
 * Union of the regression search and the blocker search, one bug per issue key.
 * A key present in both sets is a blocker.
 *
 * @param {object[]} regressions - Found-in search results.
 * @param {object[]} blockers - Blocker search results. Empty when the filter is OPEN.
 * @param {object} options - Mapping options.
 * @param {Function} options.teamLabelFor - Registry lookup from project key to label.
 * @param {string} options.browseBaseUrl - Jira site origin.
 * @returns {object[]} Zap bugs.
 */
export function mergeJiraIssues(
  regressions,
  blockers,
  { teamLabelFor, browseBaseUrl },
) {
  const byKey = new Map();
  for (const issue of regressions) {
    byKey.set(issue.key, { issue, inBlockersSet: false });
  }
  for (const issue of blockers) {
    const existing = byKey.get(issue.key);
    if (existing) {
      existing.inBlockersSet = true;
    } else {
      byKey.set(issue.key, { issue, inBlockersSet: true });
    }
  }

  return [...byKey.values()].map(({ issue, inBlockersSet }) =>
    jiraIssueToRcBug(issue, {
      teamLabel: teamLabelFor(issue.fields?.project?.key),
      inBlockersSet,
      browseBaseUrl,
    }),
  );
}
