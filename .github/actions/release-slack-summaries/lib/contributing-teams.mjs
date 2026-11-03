/**
 * Zap 597 no longer reads the Release Progress Tracker sheet.
 * Contributing teams are the sign-off checklist lines (MCRM-155 597-4),
 * mapped to topology labels with the same name/label match the crafting
 * script uses. A line with no match is passed through unchanged so the
 * script's "not in team registry" sentence still appears.
 */

const TEAM_CHECKLIST_SECTION =
  /(?:# Team sign-off checklist|## ✅ Team Sign-Off Checklist)[\s\S]*?\n([\s\S]+?)\n\s*\n/u;

/**
 * First Google Sheets URL in the pull request body.
 * OPEN (597-4): assumed to be the Testing Plan link. Wording in the Slack
 * message is unchanged.
 *
 * @param {string} releasePrBody - Pull request body.
 * @returns {string} URL, or empty when none is present.
 */
export function extractTestingPlanLink(releasePrBody) {
  const match = (releasePrBody || '').match(
    /https:\/\/docs\.google\.com\/spreadsheets\/[^\s)>]+/u,
  );
  if (!match) {
    return '';
  }
  return match[0].replace(/[.,]$/u, '');
}

/**
 * Escapes a team name for a literal regular expression.
 *
 * @param {string} value - Topology name or label interpolated into a RegExp.
 * @returns {string} Escaped literal.
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * Inverse of the Zap's sign-off match: display name (`name` with the first
 * `" team"` removed) or the github label, case-insensitive. The longest
 * match wins so a shorter name cannot claim a longer checklist line.
 *
 * @param {string} line - One checklist line.
 * @param {object} teams - Topology map keyed by github label.
 * @returns {string | null} Label, or null when nothing matches.
 */
function matchTeamLabel(line, teams) {
  let best = null;
  let bestLength = -1;
  for (const [label, team] of Object.entries(teams)) {
    const display = team?.name?.replace(' team', '') || label;
    const byName = new RegExp(`- \\[([ xX])\\] ${escapeRegExp(display)}`, 'iu');
    const byLabel = new RegExp(`- \\[([ xX])\\] ${escapeRegExp(label)}`, 'iu');
    if (byName.test(line) || byLabel.test(line)) {
      const length = Math.max(display.length, label.length);
      if (length > bestLength) {
        best = label;
        bestLength = length;
      }
    }
  }
  return best;
}

/**
 * Reads checklist lines and maps them to topology labels.
 *
 * @param {string} releasePrBody - Pull request body.
 * @param {object} teams - Topology map keyed by github label.
 * @returns {string[]} Labels in checklist order. Unknown lines are the raw text.
 */
export function contributingTeamLabels(releasePrBody, teams) {
  const match = (releasePrBody || '').match(TEAM_CHECKLIST_SECTION);
  const section = match ? match[1].trim() : '';
  const lines = section
    .split('\n')
    .filter((line) => line.trim().startsWith('- ['));
  const labels = [];
  for (const line of lines) {
    const name = line.replace(/^- \[[xX ]\]\s*/u, '').trim();
    if (name) {
      const label = matchTeamLabel(line, teams) ?? name;
      if (!labels.includes(label)) {
        labels.push(label);
      }
    }
  }
  return labels;
}
