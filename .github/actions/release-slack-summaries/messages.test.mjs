import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { mergeJiraIssues } from './lib/adapter.mjs';
import {
  contributingTeamLabels,
  extractTestingPlanLink,
} from './lib/contributing-teams.mjs';
import { craftBlockerSummary } from './lib/craft-596.mjs';
import { craftReleaseValidation } from './lib/craft-597.mjs';
import { extractDownloadUrls } from './lib/release-pr.mjs';
import { indexTeams } from './lib/teams.mjs';

process.env.TZ = 'UTC';

/**
 * Reads one fixture shipped with this action.
 *
 * @param {string} name - Fixture file name.
 * @returns {string} File contents.
 */
function fixture(name) {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
}

/**
 * Formats today the way Zap 596 formats the date line.
 *
 * @returns {string} The Zap's en-US long date, so the assertion tracks the same call.
 */
function zapDateLine() {
  return new Date().toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

const teams596 = {
  'team-extension-platform': {
    name: 'Extension Platform team',
    contact: '@release-contact-extension-platform',
  },
};

describe('craftBlockerSummary', () => {
  it('builds the Zap 596 message verbatim', () => {
    const result = craftBlockerSummary({
      teams: teams596,
      releaseVersion: '13.53.0',
      githubRepo: 'metamask-extension',
      rcBugs: [
        {
          name: 'Login crash',
          url: 'https://consensyssoftware.atlassian.net/browse/ASSETS-1',
          closed: 'false',
          assigneesLength: 0,
          labels: ['team-extension-platform', 'release-blocker'],
        },
        {
          name: 'Icon glitch',
          url: 'https://consensyssoftware.atlassian.net/browse/ASSETS-2',
          closed: 'false',
          assigneesLength: 1,
          labels: ['team-extension-platform'],
        },
        {
          name: 'Closed crash',
          url: 'https://consensyssoftware.atlassian.net/browse/ASSETS-3',
          closed: 'true',
          assigneesLength: 1,
          labels: ['release-blocker'],
        },
        {
          name: 'v13.53.0 Bug Report',
          url: 'https://example.invalid/bug',
          closed: 'false',
          assigneesLength: 0,
          labels: ['release-blocker'],
        },
      ],
    });

    assert.equal(
      result.slackMessage,
      `*Date:* ${zapDateLine()}

:stop: *Release Blockers* :stop:

*Important:* All release blockers must be resolved before release sign-off.

• <https://consensyssoftware.atlassian.net/browse/ASSETS-1|Login crash>,@release-contact-extension-platform Issue needs an assignee :hi_wave:

:warning:  *Release regressions* :warning:

*Note:* All teams should do their best to resolve release regressions before release sign-off.

• <https://consensyssoftware.atlassian.net/browse/ASSETS-2|Icon glitch>,@release-contact-extension-platform

@release-owner-extension`,
    );
    assert.equal(
      result.slackMessageTitle,
      'Extension release bug summary for v13.53.0\n\n',
    );
    assert.equal(result.slackChannelName, 'release-extension-13-53-0');
    assert.equal(result.slackMessageIcon, ':electric_plug:');
    assert.equal(result.platform, 'Extension');
    assert.match(zapDateLine(), /^[A-Z][a-z]+ \d{1,2}, \d{4}$/u);
  });

  it('uses the team-label sentence when the project is not in the registry', () => {
    const result = craftBlockerSummary({
      teams: teams596,
      releaseVersion: '13.53.0',
      githubRepo: 'metamask-mobile',
      rcBugs: [
        {
          name: 'Unmapped project blocker',
          url: 'https://consensyssoftware.atlassian.net/browse/PRED-4',
          closed: 'false',
          assigneesLength: '0',
          labels: ['release-blocker', 'PRED'],
        },
      ],
    });

    assert.match(
      result.slackMessage,
      /• <https:\/\/consensyssoftware\.atlassian\.net\/browse\/PRED-4\|Unmapped project blocker>, Issue needs a team label :hi_wave: Issue needs an assignee :hi_wave:/u,
    );
    assert.match(result.slackMessage, /@release-owner-mobile$/u);
    assert.equal(result.slackMessageIcon, ':iphone:');
    assert.equal(result.slackChannelName, 'release-mobile-13-53-0');
  });

  it('says there are no remaining bugs only when the RC set is empty', () => {
    const empty = craftBlockerSummary({
      teams: teams596,
      releaseVersion: '1.0.0',
      githubRepo: 'metamask-extension',
      rcBugs: [],
    });
    assert.equal(
      empty.slackMessage,
      `*Date:* ${zapDateLine()}

:white_check_mark: *No remaining bugs* :white_check_mark:

@release-owner-extension`,
    );

    const allClosed = craftBlockerSummary({
      teams: teams596,
      releaseVersion: '1.0.0',
      githubRepo: 'metamask-extension',
      rcBugs: [
        {
          name: 'Closed crash',
          url: 'https://consensyssoftware.atlassian.net/browse/ASSETS-3',
          closed: 'true',
          assigneesLength: 1,
          labels: ['team-extension-platform', 'release-blocker'],
        },
      ],
    });
    assert.equal(
      allClosed.slackMessage,
      `*Date:* ${zapDateLine()}

@release-owner-extension`,
    );
    assert.doesNotMatch(allClosed.slackMessage, /Release Blockers/u);
    assert.doesNotMatch(allClosed.slackMessage, /No remaining bugs/u);
  });

  it('rejects an unknown repository instead of guessing a platform', () => {
    assert.throws(
      () =>
        craftBlockerSummary({
          teams: teams596,
          releaseVersion: '1.0.0',
          githubRepo: 'metamask-planning',
          rcBugs: [],
        }),
      /unknown platform \(metamask-planning\)/u,
    );
  });
});

describe('craftReleaseValidation', () => {
  const topology = JSON.parse(fixture('topology.json'));
  const { teams } = indexTeams(topology, 'jiraProject');
  const issues = JSON.parse(fixture('jira-issues.json'));
  const body = fixture('release-pr-body.md');
  const comment = fixture('build-comment.html');
  const blockerJql = 'filter = 12345 AND cf[14565] = "13.53.0"';
  const bugs = mergeJiraIssues(issues.regressions, issues.blockers, {
    teamLabelFor: (projectKey) => {
      const team = Object.entries(teams).find(([, value]) =>
        value.jiraProjects.includes(projectKey),
      );
      return team ? team[0] : undefined;
    },
    browseBaseUrl: 'https://consensyssoftware.atlassian.net',
  });

  /**
   * Crafts a release-validation message from the shared fixtures.
   *
   * @param {object} [overrides] - Craft input overrides.
   * @returns {object} Craft result.
   */
  function craft(overrides = {}) {
    const downloads = extractDownloadUrls(comment, 'Extension');
    return craftReleaseValidation({
      teams,
      platform: 'Extension',
      releaseVersion: '13.53.0',
      contributingTeamLabels: contributingTeamLabels(body, teams),
      releasePrUrl: 'https://github.com/MetaMask/metamask-extension/pull/10',
      releasePrBody: body,
      releaseDownloadUrl1: downloads.downloadUrl1,
      releaseDownloadUrl2: downloads.downloadUrl2,
      releaseEpicCreatedAt: '2026-10-23T12:00:00.000Z',
      rcBugs: bugs,
      blockerJql,
      jiraBaseUrl: 'https://consensyssoftware.atlassian.net',
      testingPlanLink: extractTestingPlanLink(body),
      ...overrides,
    });
  }

  it('builds the Zap 597 message from the fixtures', () => {
    const result = craft();
    const extensionBlockerUrl =
      'https://consensyssoftware.atlassian.net/issues/?jql=filter%20%3D%2012345%20AND%20cf%5B14565%5D%20%3D%20%2213.53.0%22%20AND%20project%20%3D%20ASSETS';
    const designBlockerUrl =
      'https://consensyssoftware.atlassian.net/issues/?jql=filter%20%3D%2012345%20AND%20cf%5B14565%5D%20%3D%20%2213.53.0%22%20AND%20project%20%3D%20DSYS';

    assert.equal(
      result.slackMessage,
      `

*Current Release Summary*

Dates:
• Release Cut: *Oct 23*
• Deadline Date for Release Submission: *Oct 30*

Latest builds available for testing:
• <https://github.com/MetaMask/metamask-extension/releases/download/build-dist-browserify/builds/metamask-chrome-13.53.0.zip|chrome>
• <https://github.com/MetaMask/metamask-extension/releases/download/build-dist-mv2-browserify/builds/metamask-firefox-13.53.0.zip|firefox>

Useful links:
• <https://github.com/MetaMask/metamask-extension/pull/10|Release PR on GitHub>
• <https://docs.google.com/spreadsheets/d/SHEETID/edit?gid=99#gid=99|Testing Plan & Progress Tracker on Google Sheets>
• <https://www.notion.so/metamask-consensys/Simplified-Bug-Triage-Framework-53bf8b5377fc4ceaad34177fc6e8740e|Triage Framework>
• <https://app.runway.team/dashboard/org/org_4tzZCk2L/app/metamask-extension-react-native-ota/releases/13.53.0/step/featureReadiness/summary?sort=codeLastUpdated|Cherry-Pick Tracker on Runway>
• <https://consensyssoftware.atlassian.net/issues/?jql=filter%20%3D%2012345%20AND%20cf%5B14565%5D%20%3D%20%2213.53.0%22|3 Release Blockers>

Teams sign off:

:stop: Extension Platform @release-contact-extension-platform :arrow_right: <${extensionBlockerUrl}|*1 release blocker*>
:stop: Design System @release-contact-design-system :arrow_right: <${designBlockerUrl}|*1 release blocker*>
    • team is not listed amongst contributing teams in the <https://docs.google.com/spreadsheets/d/SHEETID/edit?gid=99#gid=99|release sheet>, but has <${designBlockerUrl}|blockers> assigned, which is why sign off is requested
:stop: PRED :arrow_right: <https://github.com/MetaMask/MetaMask-planning/blob/main/topology.json|*team is not in team registry, please add it*>
:large_green_circle: Mobile Platform

*Important Reminder:*

Please be aware of the importance of starting your testing immediately to ensure there is sufficient time to address any unexpected defects. This proactive approach will help prevent release delays and minimize impact on other teams’ deliveries.

cc <@U032GHTQDKK> <@U0513NJ3TAB> <@U0204J1ANFR> <@UBGR2LNBS>
`,
    );
    assert.equal(
      result.slackMessageTitle,
      'Extension 13.53.0 Release Validation',
    );
    assert.equal(result.slackChannelName, 'release-extension-13-53-0');
    assert.equal(result.slackMessageIcon, ':electric_plug:');
    assert.doesNotMatch(result.slackMessage, /QA Team/u);
    assert.doesNotMatch(result.slackMessage, /@dylan\.butler/u);
  });

  it('sorts the checklist and appends blocker teams that have no line', () => {
    const result = craft();
    assert.equal(
      result.updatedReleasePrBody,
      `## Summary

Testing plan: https://docs.google.com/spreadsheets/d/SHEETID/edit?gid=99#gid=99

# Team sign-off checklist
- [ ] Design System
- [ ] Extension Platform
- [x] Mobile Platform
- [ ] PRED
- [x] QA Team

Follow the checklist before release.
`,
    );

    const second = craft({ releasePrBody: result.updatedReleasePrBody });
    assert.equal(second.updatedReleasePrBody, undefined);
  });

  it('rewrites a changed mobile checklist and leaves an unchanged one alone', () => {
    const mobileBody = `## ✅ Team Sign-Off Checklist
- [ ] Mobile Platform
- [x] Extension Platform

Notes.
`;
    const result = craftReleaseValidation({
      teams,
      platform: 'Mobile',
      releaseVersion: '13.53.0',
      contributingTeamLabels: [
        'team-extension-platform',
        'team-mobile-platform',
      ],
      releasePrUrl: 'https://github.com/MetaMask/metamask-mobile/pull/4',
      releasePrBody: mobileBody,
      releaseDownloadUrl1: '',
      releaseDownloadUrl2: '',
      releaseEpicCreatedAt: '',
      rcBugs: [],
      blockerJql: null,
      jiraBaseUrl: 'https://consensyssoftware.atlassian.net',
      testingPlanLink: '',
    });

    assert.equal(
      result.updatedReleasePrBody,
      `# Team sign-off checklist
- [x] Extension Platform
- [ ] Mobile Platform

Notes.
`,
    );
    assert.match(
      result.slackMessage,
      /:red_circle: Mobile Platform @release-contact-mobile-platform\n/u,
    );
    assert.match(
      result.slackMessage,
      /:large_green_circle: Extension Platform\n/u,
    );
    assert.match(result.slackMessage, /Release Cut: \*Unknown Date\*/u);
    assert.doesNotMatch(result.slackMessage, /Latest builds/u);
    assert.doesNotMatch(result.slackMessage, /Release Blocker/u);
    assert.equal(result.slackMessageIcon, ':iphone:');
    assert.equal(result.slackChannelName, 'release-mobile-13-53-0');

    const unchanged = craftReleaseValidation({
      teams,
      platform: 'Mobile',
      releaseVersion: '13.53.0',
      contributingTeamLabels: ['team-extension-platform'],
      releasePrUrl: 'https://github.com/MetaMask/metamask-mobile/pull/4',
      releasePrBody: `## ✅ Team Sign-Off Checklist
- [ ] Extension Platform

Notes.
`,
      releaseDownloadUrl1: '',
      releaseDownloadUrl2: '',
      releaseEpicCreatedAt: '',
      rcBugs: [],
      blockerJql: null,
      jiraBaseUrl: 'https://consensyssoftware.atlassian.net',
      testingPlanLink: '',
    });
    assert.equal(unchanged.updatedReleasePrBody, undefined);
    assert.match(
      unchanged.slackMessage,
      /:red_circle: Extension Platform @release-contact-extension-platform\n/u,
    );
  });
});
