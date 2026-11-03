/**
 * Zap 596 Slack message (release blocker summary).
 *
 * Port of `zaps/main/release-blocker-notification-automation/scripts/slack-message-crafting.js`
 * at metamask-zaps@dc70d6792cbaf9d99f39982868baf7f090dea0af.
 * Message text is unchanged. `inputData` is the function argument.
 * The platform branch keys off the code repository (MCRM-155 C3).
 * `release_epic_url` was read by the Zap and never used, so it is not an argument.
 */

/**
 * Builds the Zap 596 Slack message.
 *
 * @param {object} input - Zap inputData, as arguments.
 * @param {object} input.teams - `githubLabel.name` → `{ name, contact }`.
 * @param {string} input.releaseVersion - `X.Y.Z` from the release ref. Not guessed.
 * @param {string} input.githubRepo - `metamask-extension` or `metamask-mobile`.
 * @param {object[]} input.rcBugs - Adapter output. `closed` is `"true"` / `"false"`.
 * @returns {object} Slack fields the Zap wrote to `output`.
 */
export function craftBlockerSummary({
  teams,
  releaseVersion,
  githubRepo,
  rcBugs: rawRcBugs,
}) {
  const teamLabels = Object.keys(teams);

  const rcBugs = rawRcBugs
    .map((bug) => {
      return {
        ...bug,
        closed: bug?.closed?.toLowerCase() === 'true',
        assigneesLength: Number(bug.assigneesLength),
      };
    })
    .filter((bug) => !bug?.name?.includes('Bug Report'));

  const blockers = rcBugs.filter((bug) => {
    return bug.labels.includes('release-blocker');
  });
  const openBlockers = blockers.filter((blocker) => !blocker.closed);

  const nonBlockers = rcBugs.filter((bug) => {
    return !bug.labels.includes('release-blocker');
  });
  const openNonBlockers = nonBlockers.filter((blocker) => !blocker.closed);

  let platform;
  let platformIcon;
  let releaseOwner;
  if (githubRepo?.toLowerCase() === 'metamask-extension') {
    platform = 'Extension';
    platformIcon = ':electric_plug:';
    releaseOwner = '@release-owner-extension';
  } else if (githubRepo?.toLowerCase() === 'metamask-mobile') {
    platform = 'Mobile';
    platformIcon = ':iphone:';
    releaseOwner = '@release-owner-mobile';
  } else {
    throw new Error(`Shall never happen: unknown platform (${githubRepo})`);
  }

  const findTeamLabels = (bug) => {
    return bug.labels.filter((label) => teamLabels.includes(label));
  };

  const craftTeamResponsible = (bug) => {
    let teamName = '';
    let teamContact = '';
    const bugTeamLabels = findTeamLabels(bug);
    bugTeamLabels.forEach((label) => {
      if (teamName) {
        teamName += ', ';
      }
      if (teamContact) {
        teamContact += ' ';
      }
      teamName += teams[label]?.name;
      teamContact += teams[label]?.contact;
    });

    if (bugTeamLabels?.length > 1) {
      teamName += '(:warning: more than 1 team assigned to this bug)';
    }

    return {
      name: teamName || ' Issue needs a team label :hi_wave:',
      contact: teamContact || ' Issue needs a team label :hi_wave:',
    };
  };

  const craftBugsList = (bugs) => {
    let bugsList = '';

    if (bugs.length > 0) {
      bugs.forEach((bug) => {
        const teamResponsible = craftTeamResponsible(bug);
        const assigneeWarning =
          bug.assigneesLength < 1 ? ' Issue needs an assignee :hi_wave:' : '';

        bugsList += `• <${bug?.url}|${bug?.name}>,${teamResponsible?.contact}${assigneeWarning}\n`;
      });
      bugsList += `\n`;
    }
    return bugsList;
  };

  const slackMessageTitle = `${platform} release bug summary for v${releaseVersion}\n\n`;

  let slackMessage = `*Date:* ${new Date().toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })}\n\n`;

  if (openBlockers.length > 0) {
    slackMessage += `:stop: *Release Blockers* :stop:\n\n*Important:* All release blockers must be resolved before release sign-off.\n\n`;
    slackMessage += craftBugsList(openBlockers);
  }

  if (openNonBlockers.length > 0) {
    slackMessage += `:warning:  *Release regressions* :warning:\n\n*Note:* All teams should do their best to resolve release regressions before release sign-off.\n\n`;
    slackMessage += craftBugsList(openNonBlockers);
  }

  if (rcBugs.length === 0) {
    slackMessage += `:white_check_mark: *No remaining bugs* :white_check_mark:\n\n`;
  }

  slackMessage += `${releaseOwner}`;

  const slackThread = `*${platform} v${releaseVersion}* :thread:`;
  const slackChannelName = `release-${platform.toLocaleLowerCase()}-${releaseVersion.replaceAll('.', '-')}`;

  return {
    platform,
    slackChannelName,
    slackThreadWithoutBold: slackThread.replace(/\*/gu, ''),
    slackThread,
    slackMessage,
    slackMessageIcon: platformIcon,
    slackMessageTitle,
  };
}
