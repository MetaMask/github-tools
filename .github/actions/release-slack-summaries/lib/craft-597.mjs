/**
 * Zap 597 Slack message (release validation) and the release PR checklist rewrite.
 *
 * Port of `zaps/main/release-sign-off-notification-automation/scripts/slack-message-crafting.js`
 * at metamask-zaps@dc70d6792cbaf9d99f39982868baf7f090dea0af.
 * Message text is unchanged except the values MCRM-155 names:
 * Release Cut is the argument (the runner passes the PR `created_at`);
 * `testingPlanLink` is the PR-body Sheets URL; blocker links are Jira JQL
 * (597-8); cc handles are the Slack user ids from the v3 posts (597-10).
 * The sheet id / gid inputs are gone with the sheet read.
 *
 * `updatedReleasePrBody` is set only when the checklist text changes. That is
 * the code path. The Zapier path-B condition ("Does not exist") reads oddly
 * and stays OPEN; the runner writes only when this function returns a body.
 */

import { jiraIssuesUrl, projectScopedJql } from './jira.mjs';

/**
 * Escapes a team name for a literal regular expression.
 *
 * @param {string} value - Team name or label placed in a RegExp.
 * @returns {string} Literal pattern.
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * Builds the Zap 597 Slack message and the checklist rewrite.
 *
 * @param {object} input - Zap inputs that still apply, plus the Jira URL pieces.
 * @param {object} input.teams - Topology map. `jiraProjects` is read for per-team JQL.
 * @param {string} input.platform - `Extension` or `Mobile`.
 * @param {string} input.releaseVersion - `X.Y.Z`.
 * @param {string[]} input.contributingTeamLabels - Checklist labels, in order.
 * @param {string} input.releasePrUrl - Release pull request URL.
 * @param {string} input.releasePrBody - Release pull request body.
 * @param {string} input.releaseDownloadUrl1 - Chrome (Extension) build URL.
 * @param {string} input.releaseDownloadUrl2 - Firefox (Extension) build URL.
 * @param {string} input.releaseEpicCreatedAt - Pull request `created_at`.
 * @param {object[]} input.rcBugs - Adapter output.
 * @param {string | null} input.blockerJql - Per-release blocker JQL, or null when OPEN.
 * @param {string} input.jiraBaseUrl - Jira site origin.
 * @param {string} input.testingPlanLink - Sheets URL from the PR body.
 * @returns {object} Slack fields plus `updatedReleasePrBody` when the checklist changed.
 */
export function craftReleaseValidation({
  teams,
  platform,
  releaseVersion,
  contributingTeamLabels,
  releasePrUrl,
  releasePrBody,
  releaseDownloadUrl1,
  releaseDownloadUrl2,
  releaseEpicCreatedAt,
  rcBugs: rawRcBugs,
  blockerJql,
  jiraBaseUrl,
  testingPlanLink,
}) {
  const teamLabels = Object.keys(teams);

  const teamLabelsToIgnore = [
    'team-external-contributor',
    'team-dev-ops',
    'team-qa',
    'team-bot',
    'unknown',
  ];
  const contributingTeams = [
    ...new Set(
      (contributingTeamLabels ?? [])
        .map((label) => String(label).trim())
        .filter(Boolean),
    ),
  ].filter((label) => !teamLabelsToIgnore.includes(label));
  const nonContributingTeamsWithBlockersAssigned = [];
  // Blocker projects with no topology team. Shown with the registry sentence
  // (597-9). They are not "non-contributing teams", so they do not get that
  // extra sheet bullet. They are still appended to the checklist as
  // `- [ ] {KEY}` because the rewrite has no team name to use (OPEN until
  // `jiraProject` is filled in).
  const unmappedBlockerLabels = [];

  const rcBugs = rawRcBugs
    .map((bug) => {
      return {
        ...bug,
        closed: bug?.closed?.toLowerCase() === 'true',
      };
    })
    .filter((bug) => !bug?.name?.includes('Bug Report'));

  const blockers = rcBugs.filter((bug) => {
    return bug.labels.includes('release-blocker');
  });
  const openBlockersCount = blockers?.filter(
    (blocker) => !blocker.closed,
  )?.length;

  const formatDate = (
    dateString,
    options = { month: 'short', day: '2-digit' },
  ) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', options);
  };

  const addDays = (dateString, days) => {
    const date = new Date(dateString);
    date.setDate(date.getDate() + days);
    return date.toISOString();
  };

  const releaseBlockerUrl = blockerJql
    ? jiraIssuesUrl(jiraBaseUrl, blockerJql)
    : '';

  let platformIcon;
  let cherryPickTrackerUrl;
  let buildType1;
  let buildType2;
  let timeBetweenTwoReleases;
  if (platform === 'Extension') {
    platformIcon = ':electric_plug:';
    cherryPickTrackerUrl = `https://app.runway.team/dashboard/org/org_4tzZCk2L/app/metamask-extension-react-native-ota/releases/${releaseVersion}/step/featureReadiness/summary?sort=codeLastUpdated`;
    buildType1 = 'chrome';
    buildType2 = 'firefox';
    timeBetweenTwoReleases = 7;
  } else if (platform === 'Mobile') {
    platformIcon = ':iphone:';
    cherryPickTrackerUrl = `https://app.runway.team/dashboard/org/org_4tzZCk2L/app/metamask-blockchain-wall-ios3/releases/${releaseVersion}/step/featureReadiness/summary?sort=codeLastUpdated`;
    buildType1 = 'ios';
    buildType2 = 'android';
    timeBetweenTwoReleases = 7;
  } else {
    throw new Error(`Shall never happen: unknown platform (${platform})`);
  }

  const releaseCutDate = releaseEpicCreatedAt
    ? formatDate(releaseEpicCreatedAt)
    : 'Unknown Date';
  const releaseSubmissionDeadlineDate = releaseEpicCreatedAt
    ? formatDate(addDays(releaseEpicCreatedAt, timeBetweenTwoReleases))
    : 'Unknown Date';

  const teamBlockers = {};
  blockers.forEach((bug) => {
    const knownLabels = bug.labels.filter(
      (label) => label !== 'release-blocker' && teamLabels.includes(label),
    );
    knownLabels.forEach((label) => {
      if (!teamBlockers[label]) {
        teamBlockers[label] = [];
      }
      teamBlockers[label].push(bug);

      if (
        !contributingTeams.includes(label) &&
        !nonContributingTeamsWithBlockersAssigned.includes(label)
      ) {
        nonContributingTeamsWithBlockersAssigned.push(label);
      }
    });

    if (knownLabels.length === 0 && bug.projectKey) {
      const label = bug.projectKey;
      if (!teamBlockers[label]) {
        teamBlockers[label] = [];
      }
      teamBlockers[label].push(bug);
      if (
        !contributingTeams.includes(label) &&
        !unmappedBlockerLabels.includes(label)
      ) {
        unmappedBlockerLabels.push(label);
      }
    }
  });

  const signOffLabels = [
    ...contributingTeams,
    ...nonContributingTeamsWithBlockersAssigned,
    ...unmappedBlockerLabels,
  ];

  const teamSignOffs = {};
  const teamChecklistSectionMatch = (releasePrBody || '').match(
    /(?:# Team sign-off checklist|## ✅ Team Sign-Off Checklist)[\s\S]*?\n([\s\S]+?)\n\s*\n/u,
  );
  const teamChecklistSection = teamChecklistSectionMatch
    ? teamChecklistSectionMatch[1].trim()
    : '';

  const missingTeamsInChecklistSection = [];
  signOffLabels.forEach((teamLabel) => {
    const teamDisplayName =
      teams[teamLabel]?.name?.replace(' team', '') || teamLabel;
    // Names are escaped so a parenthesis in a checklist label cannot throw.
    // The Zap interpolated them raw; current topology names have no metacharacters.
    const teamLabelRegex1 = new RegExp(
      `- \\[([ xX])\\] ${escapeRegExp(teamDisplayName)}`,
      'iu',
    );
    const teamLabelRegex2 = new RegExp(
      `- \\[([ xX])\\] ${escapeRegExp(teamLabel)}`,
      'iu',
    );
    const match1 = teamChecklistSection.match(teamLabelRegex1);
    const match2 = teamChecklistSection.match(teamLabelRegex2);

    if (
      (match1 && match1[1].toLowerCase() === 'x') ||
      (match2 && match2[1].toLowerCase() === 'x')
    ) {
      teamSignOffs[teamLabel] = true;
    } else if (match1 || match2) {
      teamSignOffs[teamLabel] = false;
    } else {
      teamSignOffs[teamLabel] = false;
      missingTeamsInChecklistSection.push(`- [ ] ${teamDisplayName}`);
    }
  });

  let updatedReleasePrBody;
  if (teamChecklistSectionMatch) {
    const existingChecklistItems = teamChecklistSection
      .split('\n')
      .filter((line) => line.trim().startsWith('- ['));
    const allChecklistItems = [
      ...existingChecklistItems,
      ...missingTeamsInChecklistSection,
    ];
    const sortedChecklistItems = allChecklistItems.sort((itemA, itemB) => {
      const teamNameA = itemA
        .replace(/^- \[[xX ]\]\s*/u, '')
        .trim()
        .toLowerCase();
      const teamNameB = itemB
        .replace(/^- \[[xX ]\]\s*/u, '')
        .trim()
        .toLowerCase();
      return teamNameA.localeCompare(teamNameB);
    });
    const updatedTeamChecklistSection = sortedChecklistItems.join('\n');

    if (updatedTeamChecklistSection !== teamChecklistSection) {
      updatedReleasePrBody = releasePrBody.replace(
        /(?:# Team sign-off checklist|## ✅ Team Sign-Off Checklist)[\s\S]*?\n([\s\S]+?)\n\s*\n/u,
        `# Team sign-off checklist\n${updatedTeamChecklistSection}\n\n`,
      );
    }
  }

  const slackMessageTitle = `${platform} ${releaseVersion} Release Validation`;

  let slackMessage = `

*Current Release Summary*

Dates:
• Release Cut: *${releaseCutDate}*
• Deadline Date for Release Submission: *${releaseSubmissionDeadlineDate}*`;

  if (releaseDownloadUrl1 && releaseDownloadUrl2) {
    slackMessage += `

Latest builds available for testing:
• <${releaseDownloadUrl1}|${buildType1}>
• <${releaseDownloadUrl2}|${buildType2}>`;
  }

  slackMessage += `

Useful links:
• <${releasePrUrl}|Release PR on GitHub>
• <${testingPlanLink}|Testing Plan & Progress Tracker on Google Sheets>
• <https://www.notion.so/metamask-consensys/Simplified-Bug-Triage-Framework-53bf8b5377fc4ceaad34177fc6e8740e|Triage Framework>
• <${cherryPickTrackerUrl}|Cherry-Pick Tracker on Runway>`;

  // Blocker bullet is the Zap's last useful-link line. It is omitted when the
  // saved filter JQL is empty (interface: skip the blocker section, log OPEN).
  if (releaseBlockerUrl) {
    slackMessage += `
• <${releaseBlockerUrl}|${openBlockersCount} ${openBlockersCount === 1 ? 'Release Blocker' : 'Release Blockers'}>`;
  }

  slackMessage += `

Teams sign off:\n\n`;

  let stopSlackMessage = '';
  let redSlackMessage = '';
  let greenSlackMessage = '';
  for (const team of signOffLabels) {
    let teamSlackMessage = '';
    const teamName = teams[team]?.name?.replace(' team', '');
    const teamSignOffContact = teams[team]?.contact || '';
    let notifyTeam = false;
    const openBlockers = teamBlockers?.[team]?.filter(
      (blocker) => !blocker.closed,
    );

    if (openBlockers?.length > 0) {
      teamSlackMessage += `:stop:`;
      notifyTeam = true;
    } else if (teamSignOffs[team]) {
      teamSlackMessage += ':large_green_circle:';
    } else {
      teamSlackMessage += ':red_circle:';
      notifyTeam = true;
    }

    const teamProjects = teams[team]?.jiraProjects ?? [];
    const blockerUrl = blockerJql
      ? jiraIssuesUrl(jiraBaseUrl, projectScopedJql(blockerJql, teamProjects))
      : '';

    if (teamName) {
      teamSlackMessage += ` ${teamName}`;

      if (notifyTeam) {
        teamSlackMessage += ` ${teamSignOffContact}`;
      }

      if (openBlockers?.length > 0 && blockerUrl) {
        teamSlackMessage += ` :arrow_right: <${blockerUrl}|*${openBlockers.length} release blocker${openBlockers.length > 1 ? 's' : ''}*>`;
      }
    } else {
      teamSlackMessage += ` ${team} :arrow_right: <https://github.com/MetaMask/MetaMask-planning/blob/main/topology.json|*team is not in team registry, please add it*>`;
    }

    if (nonContributingTeamsWithBlockersAssigned.includes(team)) {
      teamSlackMessage += `\n    • team is not listed amongst contributing teams in the <${testingPlanLink}|release sheet>, but has <${blockerUrl}|blockers> assigned, which is why sign off is requested`;
    }

    teamSlackMessage += `\n`;

    if (openBlockers?.length > 0) {
      stopSlackMessage += teamSlackMessage;
    } else if (teamSignOffs[team]) {
      greenSlackMessage += teamSlackMessage;
    } else {
      redSlackMessage += teamSlackMessage;
    }
  }

  slackMessage += stopSlackMessage;
  slackMessage += redSlackMessage;
  slackMessage += greenSlackMessage;
  slackMessage += `\n`;

  slackMessage += `*Important Reminder:*

Please be aware of the importance of starting your testing immediately to ensure there is sufficient time to address any unexpected defects. This proactive approach will help prevent release delays and minimize impact on other teams’ deliveries.

cc <@U032GHTQDKK> <@U0513NJ3TAB> <@U0204J1ANFR> <@UBGR2LNBS>\n`;

  const slackThread = `*${platform} v${releaseVersion}* :thread:`;
  const slackChannelName = `release-${platform.toLocaleLowerCase()}-${releaseVersion.replaceAll('.', '-')}`;

  return {
    slackChannelName,
    slackThreadWithoutBold: slackThread.replace(/\*/gu, ''),
    slackThread,
    slackMessage,
    slackMessageIcon: platformIcon,
    slackMessageTitle,
    updatedReleasePrBody,
  };
}
