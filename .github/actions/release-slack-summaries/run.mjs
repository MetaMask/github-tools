/**
 * Daily release Slack summaries (MCRM-155).
 *
 * Zap 596 → `blocker-summary`. Zap 597 → `release-validation`.
 * Jira is read-only. GitHub tokens are passed in by the caller (get-token);
 * this action does not mint them and does not read a personal access token.
 * Defaults: dry-run, and no pull request write unless `allow-pr-write` is set.
 */

import { Octokit } from '@octokit/rest';
import { WebClient } from '@slack/web-api';
import { appendFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { mergeJiraIssues } from './lib/adapter.mjs';
import {
  contributingTeamLabels,
  extractTestingPlanLink,
} from './lib/contributing-teams.mjs';
import { craftBlockerSummary } from './lib/craft-596.mjs';
import { craftReleaseValidation } from './lib/craft-597.mjs';
import {
  isDryRun,
  isPrWriteAllowed,
  postChannel,
  shouldWriteReleasePr,
} from './lib/gates.mjs';
import {
  buildBlockerJql,
  buildRegressionJql,
  searchJiraIssues,
  usesDefaultRegressionJql,
} from './lib/jira.mjs';
import { latestBuildFromComments, selectReleasePr } from './lib/release-pr.mjs';
import { selectReleases } from './lib/releases.mjs';
import { fetchMetaMaskTeams } from './lib/teams.mjs';

const GITHUB_OWNER = 'MetaMask';

const REPOS = {
  extension: { repo: 'metamask-extension', platformLabel: 'Extension' },
  mobile: { repo: 'metamask-mobile', platformLabel: 'Mobile' },
};

const SKIPPED_CHANNEL_ERRORS = new Set([
  'channel_not_found',
  'not_in_channel',
  'is_archived',
]);

/**
 * Reads action inputs from the environment.
 *
 * @param {NodeJS.ProcessEnv} env - Action environment.
 * @returns {object} Parsed inputs. Dry-run defaults to true.
 */
export function readConfig(env = process.env) {
  const mode = required('mode', env.MODE);
  if (mode !== 'blocker-summary' && mode !== 'release-validation') {
    throw new Error(
      `Unknown mode "${mode}". Expected blocker-summary or release-validation.`,
    );
  }
  const platform = required('platform', env.PLATFORM);
  if (platform !== 'extension' && platform !== 'mobile') {
    throw new Error(
      `Unknown platform "${platform}". Expected extension or mobile.`,
    );
  }

  const topologyField = (env.TOPOLOGY_JIRA_PROJECT_FIELD ?? '').trim();

  return {
    mode,
    platform,
    githubToken: required('github-token', env.GITHUB_TOKEN),
    planningToken: required('planning-token', env.PLANNING_TOKEN),
    slackBotToken: required('slack-bot-token', env.SLACK_BOT_TOKEN),
    jiraBaseUrl: (
      env.JIRA_BASE_URL || 'https://consensyssoftware.atlassian.net'
    ).replace(/\/$/u, ''),
    jiraEmail: required('jira-email', env.JIRA_EMAIL),
    jiraApiToken: required('jira-api-token', env.JIRA_API_TOKEN),
    jiraReleaseBlockerJql: (env.JIRA_RELEASE_BLOCKER_JQL || '').trim(),
    jiraRegressionJql: (env.JIRA_REGRESSION_JQL || '').trim(),
    topologyJiraProjectField: topologyField || 'jiraProject',
    testChannel: (env.TEST_CHANNEL || '').trim(),
    dryRun: isDryRun(env.DRY_RUN),
    allowPrWrite: isPrWriteAllowed(env.ALLOW_PR_WRITE),
  };
}

/**
 * Returns a required input or throws.
 *
 * @param {string} name - Input name, for the error.
 * @param {string | undefined} value - Raw value.
 * @returns {string} Trimmed value.
 */
function required(name, value) {
  if (!value || !String(value).trim()) {
    throw new Error(`Missing required input: ${name}`);
  }
  return String(value).trim();
}

/**
 * Appends markdown to the job summary and the log.
 *
 * @param {string} markdown - Markdown appended to the step summary and the log.
 */
function writeSummary(markdown) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (path) {
    appendFileSync(path, `${markdown}\n`);
  }
  console.log(markdown);
}

/**
 * Posts one Slack message, or skips a missing channel.
 *
 * @param {string} token - Caller-supplied Slack bot token.
 * @param {object} message - Fields for chat.postMessage.
 * @param {string} message.channel - Channel name or id.
 * @param {string} message.text - Message body.
 * @param {string} message.username - Bot name. Trailing newlines from Zap 596 are trimmed.
 * @param {string} message.iconEmoji - `:electric_plug:` or `:iphone:`.
 * @returns {Promise<{ skipped: boolean, reason?: string }>} Skip when the channel is missing.
 */
async function postSlack(token, { channel, text, username, iconEmoji }) {
  const client = new WebClient(token);
  try {
    await client.chat.postMessage({
      channel,
      text,
      username: username.trimEnd(),
      icon_emoji: iconEmoji,
      link_names: true,
      unfurl_links: false,
      unfurl_media: false,
    });
  } catch (error) {
    const code = error?.data?.error;
    if (SKIPPED_CHANNEL_ERRORS.has(code)) {
      return { skipped: true, reason: code };
    }
    throw error;
  }
  return { skipped: false };
}

/**
 * Runs one summary for every selected release.
 *
 * @param {object} config - Parsed inputs.
 * @param {object} deps - Injectable clients, for tests. Production builds them.
 * @returns {Promise<void>}
 */
export async function run(config, deps = {}) {
  const { repo, platformLabel } = REPOS[config.platform];
  const octokit =
    deps.octokit ??
    new Octokit({
      auth: config.githubToken,
      userAgent: 'metamask-github-tools-release-slack-summaries',
    });
  const searchIssues = deps.searchJiraIssues ?? searchJiraIssues;
  const loadTeams =
    deps.fetchMetaMaskTeams ??
    ((token, field) => fetchMetaMaskTeams(token, field));
  const post = deps.postSlack ?? postSlack;

  const registry = await loadTeams(
    config.planningToken,
    config.topologyJiraProjectField,
  );
  const pulls = await octokit.paginate(octokit.rest.pulls.list, {
    owner: GITHUB_OWNER,
    repo,
    state: 'open',
    base: 'stable',
    per_page: 100,
  });
  const releases = selectReleases(pulls, { mode: config.mode });
  const teamsWithProjects = Object.values(registry.teams).filter(
    (team) => team.jiraProjects.length > 0,
  ).length;

  const openLines = [];
  if (!config.jiraReleaseBlockerJql) {
    openLines.push(
      'OPEN: jira-release-blocker-jql is empty. The MetaMask Release Blockers filter is not created yet. Skipping the blocker section. Blocker issues are not queried.',
    );
  }
  if (usesDefaultRegressionJql(config.jiraRegressionJql)) {
    openLines.push(
      'OPEN: jira-regression-jql is empty. Using the v10 proposal default (Found in cf[16946] = "V" and the §4 project list). Confirm the field id and the project list.',
    );
  }
  openLines.push(
    'OPEN: the Release Blocker custom field id is unknown (cf[NNNNN]). A regression flagged Yes for a different Release Number is not excluded until that id exists.',
  );
  openLines.push(
    `OPEN: topology Jira project field "${config.topologyJiraProjectField}" is the PROPOSED name. Teams with a key: ${teamsWithProjects} of ${Object.keys(registry.teams).length}.`,
  );
  openLines.push(...registry.warnings.map((warning) => `OPEN: ${warning}`));

  writeSummary(
    [
      '# Release Slack summaries',
      '',
      `- Mode: \`${config.mode}\``,
      `- Platform: \`${config.platform}\` (\`${GITHUB_OWNER}/${repo}\`)`,
      `- Dry run: \`${config.dryRun}\` (default true; nothing is posted or written)`,
      `- Allow PR write: \`${config.allowPrWrite}\``,
      `- Test channel: \`${config.testChannel || '(none)'}\``,
      `- Releases: ${releases.map((release) => release.version).join(', ') || '(none)'}`,
      '',
      ...openLines.map((line) => `- ${line}`),
      '',
    ].join('\n'),
  );

  const failures = [];
  for (const release of releases) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await processRelease({
        config,
        octokit,
        searchIssues,
        post,
        repo,
        platformLabel,
        release,
        registry,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${release.version}: ${message}`);
      writeSummary(
        `## ${release.version}\n\nFailed before posting: ${message}\n`,
      );
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Release Slack summaries failed for: ${failures.join(' | ')}`,
    );
  }
}

/**
 * Builds the message for one release and posts or records it.
 *
 * @param {object} args - One release.
 * @param {object} args.config - Parsed action inputs.
 * @param {object} args.octokit - GitHub client for the client repository.
 * @param {Function} args.searchIssues - Read-only Jira search.
 * @param {Function} args.post - Slack poster.
 * @param {string} args.repo - Client repository name.
 * @param {string} args.platformLabel - `Extension` or `Mobile`.
 * @param {object} args.release - Selected pull request, including `version`.
 * @param {object} args.registry - Topology indexes.
 * @returns {Promise<void>} Resolves when the release is summarized.
 */
async function processRelease({
  config,
  octokit,
  searchIssues,
  post,
  repo,
  platformLabel,
  release,
  registry,
}) {
  const { version } = release;
  const blockerJql = buildBlockerJql(version, config.jiraReleaseBlockerJql);
  const regressionJql = buildRegressionJql(version, config.jiraRegressionJql);
  const jiraAuth = {
    baseUrl: config.jiraBaseUrl,
    email: config.jiraEmail,
    apiToken: config.jiraApiToken,
  };
  const regressions = await searchIssues({ ...jiraAuth, jql: regressionJql });
  const blockerIssues = blockerJql
    ? await searchIssues({ ...jiraAuth, jql: blockerJql })
    : [];
  const rcBugs = mergeJiraIssues(regressions, blockerIssues, {
    teamLabelFor: (projectKey) =>
      projectKey ? registry.projectToLabel[projectKey] : undefined,
    browseBaseUrl: config.jiraBaseUrl,
  });

  let crafted;
  let pullNumber = release.number;
  if (config.mode === 'blocker-summary') {
    crafted = craftBlockerSummary({
      teams: registry.teams,
      releaseVersion: version,
      githubRepo: repo,
      rcBugs,
    });
  } else {
    const candidate = {
      ...release,
      url: release.html_url || release.url,
    };
    const selected = selectReleasePr([candidate], version, repo);
    pullNumber = selected.number;
    const comments = await octokit.paginate(octokit.rest.issues.listComments, {
      owner: GITHUB_OWNER,
      repo,
      issue_number: selected.number,
      per_page: 100,
    });
    const latestFifty = comments.slice(-50).map((comment) => ({
      body: comment.body ?? '',
      url: comment.html_url,
      author: { login: comment.user?.login ?? '' },
    }));
    const builds = latestBuildFromComments(latestFifty, platformLabel);
    const body = selected.body || '';
    const testingPlanLink = extractTestingPlanLink(body);
    if (!testingPlanLink) {
      console.log(
        `OPEN: no docs.google.com/spreadsheets URL in the ${version} PR body. Testing Plan link is empty (597-4 assumption).`,
      );
    }
    crafted = craftReleaseValidation({
      teams: registry.teams,
      platform: platformLabel,
      releaseVersion: version,
      contributingTeamLabels: contributingTeamLabels(body, registry.teams),
      releasePrUrl: selected.html_url || selected.url || '',
      releasePrBody: body,
      releaseDownloadUrl1:
        builds.latestBuildCommentDownloadUrls.downloadUrl1 || '',
      releaseDownloadUrl2:
        builds.latestBuildCommentDownloadUrls.downloadUrl2 || '',
      releaseEpicCreatedAt: selected.created_at || '',
      rcBugs,
      blockerJql,
      jiraBaseUrl: config.jiraBaseUrl,
      testingPlanLink,
    });
  }

  const channel = postChannel(crafted.slackChannelName, config.testChannel);
  const wantsWrite =
    shouldWriteReleasePr(config) && Boolean(crafted.updatedReleasePrBody);
  const lines = [
    `## ${version}`,
    '',
    `- Computed channel: \`${crafted.slackChannelName}\``,
    `- Post target: \`${channel}\`${config.testChannel ? ' (test-channel override)' : ''}`,
    `- Dry run: \`${config.dryRun}\``,
    `- Regressions returned: ${regressions.length}`,
    `- Blockers returned: ${blockerJql ? blockerIssues.length : 'skipped (OPEN, no blocker JQL)'}`,
    `- PR write: ${describePrWrite(config, crafted.updatedReleasePrBody)}`,
  ];

  if (crafted.updatedReleasePrBody) {
    lines.push(
      '',
      '### PR checklist rewrite',
      '',
      'Before:',
      '',
      '```',
      checklistSection(release.body || ''),
      '```',
      '',
      'After:',
      '',
      '```',
      checklistSection(crafted.updatedReleasePrBody),
      '```',
    );
  }

  lines.push('', '### Message', '', '~~~~', crafted.slackMessage, '~~~~', '');
  writeSummary(lines.join('\n'));

  if (!config.dryRun) {
    const result = await post(config.slackBotToken, {
      channel,
      text: crafted.slackMessage,
      username: crafted.slackMessageTitle,
      iconEmoji: crafted.slackMessageIcon,
    });
    if (result.skipped) {
      writeSummary(
        `Skipped ${version}: Slack ${result.reason} for \`${channel}\`.\n`,
      );
    }
  }

  if (wantsWrite) {
    await octokit.rest.pulls.update({
      owner: GITHUB_OWNER,
      repo,
      pull_number: pullNumber,
      body: crafted.updatedReleasePrBody,
    });
    writeSummary(`Updated pull request #${pullNumber} body for ${version}.\n`);
  }
}

/**
 * Describes whether the pull request body will be written.
 *
 * @param {object} config - Parsed inputs.
 * @param {string | undefined} updatedBody - Rewritten body, when the checklist changed.
 * @returns {string} Summary phrase.
 */
function describePrWrite(config, updatedBody) {
  if (config.mode !== 'release-validation') {
    return 'not this mode';
  }
  if (!updatedBody) {
    return 'checklist unchanged';
  }
  if (config.dryRun) {
    return 'dry-run, not written';
  }
  if (!config.allowPrWrite) {
    return 'allow-pr-write is false, not written';
  }
  return 'will write';
}

/**
 * Returns the sign-off checklist section of a pull request body.
 *
 * @param {string} body - Pull request body.
 * @returns {string} Checklist section, or a placeholder.
 */
function checklistSection(body) {
  const match = (body || '').match(
    /(?:# Team sign-off checklist|## ✅ Team Sign-Off Checklist)[\s\S]*?\n([\s\S]+?)\n\s*\n/u,
  );
  return match ? match[1].trim() : '(no checklist section)';
}

/**
 * Reports whether this file is the Node entrypoint.
 *
 * @returns {boolean} True when this file is the node entrypoint.
 */
function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return import.meta.url === pathToFileURL(realpathSync(entry)).href;
}

if (isDirectRun()) {
  run(readConfig()).catch((error) => {
    console.error(
      error instanceof Error ? error.stack || error.message : error,
    );
    process.exitCode = 1;
  });
}
