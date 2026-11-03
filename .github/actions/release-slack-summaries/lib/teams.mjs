/**
 * Port of Zap `teams-fetching.js` (`fetchMetaMaskTeams`).
 * metamask-zaps@dc70d6792cbaf9d99f39982868baf7f090dea0af.
 *
 * Same contents URL, same base64 decode, same `githubLabel.name` →
 * `{ name, contact }` map. Also reads the per-team Jira project field.
 * The field name is PROPOSED (`jiraProject`, an array) and is an input.
 */

const TEAMS_URL =
  'https://api.github.com/repos/MetaMask/MetaMask-planning/contents/topology.json?ref=main';

/**
 * Reads Jira project keys from one topology team.
 *
 * @param {object} team - One topology.json team record.
 * @param {string} fieldName - Property that holds Jira project keys. Empty skips the read.
 * @returns {string[]} Project keys. A string or an array are both accepted (format is OPEN).
 */
export function readJiraProjects(team, fieldName) {
  if (!fieldName) {
    return [];
  }
  const raw = team?.[fieldName];
  if (raw === undefined || raw === null || raw === '') {
    return [];
  }
  if (Array.isArray(raw)) {
    return raw.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof raw === 'string') {
    return [raw.trim()].filter(Boolean);
  }
  return [];
}

/**
 * Indexes topology.json by GitHub label and Jira project key.
 *
 * @param {object} topology - Parsed topology.json.
 * @param {string} jiraProjectField - Field name to read. OPEN / PROPOSED: `jiraProject`.
 * @returns {{ teams: object, projectToLabel: object, warnings: string[] }} Registry indexes.
 */
export function indexTeams(topology, jiraProjectField) {
  const teams = {};
  const projectToLabel = {};
  const warnings = [];

  for (const [key, value] of Object.entries(topology)) {
    if (!value?.githubLabel?.name) {
      throw new Error(
        `Shall never happen: undefined team github label for: ${key}`,
      );
    }
    const label = value.githubLabel.name;
    const jiraProjects = readJiraProjects(value, jiraProjectField);
    teams[label] = {
      name: value?.name,
      contact: value?.slackHandle?.releaseContact,
      jiraProjects,
    };
    for (const projectKey of jiraProjects) {
      const existing = projectToLabel[projectKey];
      if (existing && existing !== label) {
        warnings.push(
          `Jira project ${projectKey} is listed for both ${existing} and ${label}. Using ${existing}.`,
        );
      } else {
        projectToLabel[projectKey] = label;
      }
    }
  }

  return { teams, projectToLabel, warnings };
}

/**
 * Loads topology.json from MetaMask-planning.
 *
 * @param {string} token - Contents:read token for MetaMask/MetaMask-planning, from the caller.
 * @param {string} jiraProjectField - Topology field holding Jira keys.
 * @param {Function} [fetchImpl] - Injectable fetch.
 * @returns {Promise<{ teams: object, projectToLabel: object, warnings: string[] }>} Registry indexes.
 */
export async function fetchMetaMaskTeams(
  token,
  jiraProjectField,
  fetchImpl = fetch,
) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'metamask-github-tools-release-slack-summaries',
  };
  const response = await fetchImpl(TEAMS_URL, { method: 'GET', headers });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch MetaMask teams. HTTP Status: ${response.status}`,
    );
  }

  const fileData = await response.json();
  const contentString = Buffer.from(fileData.content, 'base64').toString(
    'utf-8',
  );
  const jsonContent = JSON.parse(contentString);
  return indexTeams(jsonContent, jiraProjectField);
}
