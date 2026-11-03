/**
 * Read-only Jira search and the JQL this action is allowed to build.
 *
 * Blocker JQL is caller-supplied (`jira-release-blocker-jql`). The saved
 * filter does not exist yet, so an empty base is an OPEN skip, not a guess.
 * Per release the action appends `AND cf[14565] = "V"` (MCRM-155 interface).
 * Regression JQL defaults to the v10 proposal (Found in `cf[16946]`, §4
 * project list) until callers override `jira-regression-jql`.
 */

/** Found-in field id from MCRM-155 v10 §5.3 C7. OPEN to confirm. */
export const FOUND_IN_CUSTOM_FIELD = '16946';

/** Release Number field id. The shared interface appends this clause. */
export const RELEASE_NUMBER_CUSTOM_FIELD = '14565';

/**
 * Proposal §4 project list. OPEN: the saved filter that owns this list is not
 * created yet. Callers can replace it with `jira-regression-jql`.
 */
export const DEFAULT_REGRESSION_JQL_BASE =
  'issuetype = Bug AND project in (MUL, ASSETS, CONF, CEUX, WPC, GE, WPN, TAT, CARD, DSYS, MCWP, TMCU, TRAM, PRED, TSA, SUB, KYC, SWAPS, MWPE, STX, MUSD, MBTB)';

const MAX_PAGES = 50;

const RELEASE_VERSION = /^\d+\.\d+\.\d+$/u;

/**
 * Refuses release numbers that did not come from a `release/X.Y.Z` ref.
 *
 * @param {string} version - Candidate release number.
 */
function assertReleaseVersion(version) {
  if (!RELEASE_VERSION.test(version)) {
    throw new Error(
      `Refusing to build JQL for an unexpected release version: ${version}`,
    );
  }
}

/**
 * Appends the release number to the caller blocker JQL.
 *
 * @param {string} version - Release number from the pull request head ref.
 * @param {string} baseJql - Caller base. Empty means the blocker filter is OPEN.
 * @returns {string | null} Full blocker JQL, or null when the base is empty.
 */
export function buildBlockerJql(version, baseJql) {
  assertReleaseVersion(version);
  if (!baseJql || !baseJql.trim()) {
    return null;
  }
  return `${baseJql.trim()} AND cf[${RELEASE_NUMBER_CUSTOM_FIELD}] = "${version}"`;
}

/**
 * Builds the Found-in JQL for one release.
 *
 * @param {string} version - Release number from the pull request head ref.
 * @param {string} baseJql - Caller base. Empty uses {@link DEFAULT_REGRESSION_JQL_BASE}.
 * @returns {string} Full regression JQL.
 */
export function buildRegressionJql(version, baseJql) {
  assertReleaseVersion(version);
  const base =
    baseJql && baseJql.trim() ? baseJql.trim() : DEFAULT_REGRESSION_JQL_BASE;
  return `${base} AND cf[${FOUND_IN_CUSTOM_FIELD}] = "${version}"`;
}

/**
 * True when the regression search is using the proposal default.
 *
 * @param {string} baseJql - Caller-supplied regression base.
 * @returns {boolean} Whether the default project list is in use.
 */
export function usesDefaultRegressionJql(baseJql) {
  return !baseJql || !baseJql.trim();
}

/**
 * Adds a project clause to a per-release JQL string.
 *
 * @param {string} jql - JQL that already scopes the release.
 * @param {string[] | undefined} projectKeys - Topology keys for one team.
 * @returns {string} JQL plus `project = KEY` or `project in (...)`.
 */
export function projectScopedJql(jql, projectKeys) {
  const keys = (projectKeys ?? []).filter(Boolean);
  if (keys.length === 0) {
    return jql;
  }
  if (keys.length === 1) {
    return `${jql} AND project = ${keys[0]}`;
  }
  return `${jql} AND project in (${keys.join(', ')})`;
}

/**
 * Encodes JQL into a Jira issue-navigator URL.
 *
 * @param {string} baseUrl - Jira site origin, no trailing slash required.
 * @param {string} jql - JQL to encode into the issues navigator.
 * @returns {string} `https://…/issues/?jql=` URL.
 */
export function jiraIssuesUrl(baseUrl, jql) {
  const base = baseUrl.replace(/\/$/u, '');
  return `${base}/issues/?jql=${encodeURIComponent(jql)}`;
}

/**
 * POST `/rest/api/3/search/jql`, following `nextPageToken`. Read-only.
 *
 * @param {object} args - Search arguments.
 * @param {string} args.baseUrl - Jira site origin.
 * @param {string} args.email - Atlassian account email.
 * @param {string} args.apiToken - Atlassian API token. Never logged.
 * @param {string} args.jql - JQL to run.
 * @param {Function} [args.fetchImpl] - Injectable fetch.
 * @returns {Promise<object[]>} Issue objects.
 */
export async function searchJiraIssues({
  baseUrl,
  email,
  apiToken,
  jql,
  fetchImpl = fetch,
}) {
  const issues = [];
  let nextPageToken;
  let page = 0;
  const authorization = `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`;
  const endpoint = `${baseUrl.replace(/\/$/u, '')}/rest/api/3/search/jql`;

  do {
    page += 1;
    const body = {
      jql,
      maxResults: 100,
      // customfield_NNNNN is intentionally absent: the Release Blocker field
      // id is not assigned yet. Filtering stays in the caller-supplied JQL.
      fields: ['summary', 'assignee', 'project', 'status'],
    };
    if (nextPageToken) {
      body.nextPageToken = nextPageToken;
    }

    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Jira search failed (${response.status}): ${text.slice(0, 500)}`,
      );
    }

    const data = await response.json();
    issues.push(...(data.issues ?? []));
    nextPageToken = data.isLast ? undefined : data.nextPageToken;
  } while (nextPageToken && page < MAX_PAGES);

  if (nextPageToken) {
    throw new Error(`Jira search did not finish after ${MAX_PAGES} pages.`);
  }

  return issues;
}
