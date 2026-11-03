import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parse } from 'yaml';

import {
  isDryRun,
  isPrWriteAllowed,
  postChannel,
  shouldWriteReleasePr,
} from './lib/gates.mjs';
import { indexTeams } from './lib/teams.mjs';
import { readConfig } from './run.mjs';

/**
 * Builds a config object using the safe defaults.
 *
 * @param {object} [overrides] - Env overrides.
 * @returns {object} Parsed config.
 */
function config(overrides = {}) {
  return readConfig({
    MODE: 'blocker-summary',
    PLATFORM: 'extension',
    GITHUB_TOKEN: 'github',
    PLANNING_TOKEN: 'planning',
    SLACK_BOT_TOKEN: 'slack',
    JIRA_EMAIL: 'victor@example.com',
    JIRA_API_TOKEN: 'jira',
    ...overrides,
  });
}

describe('safe defaults', () => {
  it('dry-run is on and PR writes are off unless the caller opts in', () => {
    assert.equal(isDryRun(undefined), true);
    assert.equal(isDryRun(''), true);
    assert.equal(isDryRun('true'), true);
    assert.equal(isDryRun('false'), false);
    assert.equal(isDryRun('FALSE'), false);
    assert.equal(isPrWriteAllowed(undefined), false);
    assert.equal(isPrWriteAllowed('false'), false);
    assert.equal(isPrWriteAllowed('yes'), false);
    assert.equal(isPrWriteAllowed('true'), true);

    const defaults = config();
    assert.equal(defaults.dryRun, true);
    assert.equal(defaults.allowPrWrite, false);
    assert.equal(defaults.jiraReleaseBlockerJql, '');
    assert.equal(defaults.topologyJiraProjectField, 'jiraProject');
    assert.equal(
      defaults.jiraBaseUrl,
      'https://consensyssoftware.atlassian.net',
    );
    assert.equal(
      shouldWriteReleasePr({
        mode: 'release-validation',
        dryRun: defaults.dryRun,
        allowPrWrite: defaults.allowPrWrite,
      }),
      false,
    );
    assert.equal(
      shouldWriteReleasePr({
        mode: 'release-validation',
        dryRun: false,
        allowPrWrite: false,
      }),
      false,
    );
    assert.equal(
      shouldWriteReleasePr({
        mode: 'blocker-summary',
        dryRun: false,
        allowPrWrite: true,
      }),
      false,
    );
    assert.equal(
      shouldWriteReleasePr({
        mode: 'release-validation',
        dryRun: false,
        allowPrWrite: true,
      }),
      true,
    );
  });

  it('posts only to the test channel when one is set', () => {
    assert.equal(
      postChannel('release-extension-13-53-0', ''),
      'release-extension-13-53-0',
    );
    assert.equal(
      postChannel('release-extension-13-53-0', '#release-summary-test'),
      '#release-summary-test',
    );
  });
});

describe('topology jira projects', () => {
  it('reads an array or a string and does not invent keys that are absent', () => {
    const topology = JSON.parse(
      readFileSync(
        new URL('./fixtures/topology.json', import.meta.url),
        'utf8',
      ),
    );
    const indexed = indexTeams(topology, 'jiraProject');
    assert.equal(indexed.projectToLabel.ASSETS, 'team-extension-platform');
    assert.equal(indexed.projectToLabel.MOBILE, 'team-mobile-platform');
    assert.equal(indexed.projectToLabel.DSYS, 'team-design-system');
    assert.equal(indexed.projectToLabel.PRED, undefined);
    assert.deepEqual(indexed.teams['team-qa'].jiraProjects, ['QA']);
    assert.equal(indexed.warnings.length, 0);

    const unnamed = indexTeams(topology, '');
    assert.deepEqual(unnamed.projectToLabel, {});
  });

  it('keeps the first team when two teams claim one project', () => {
    const indexed = indexTeams(
      {
        a: {
          name: 'A team',
          githubLabel: { name: 'team-a' },
          slackHandle: { releaseContact: '@a' },
          jiraProject: ['ASSETS'],
        },
        b: {
          name: 'B team',
          githubLabel: { name: 'team-b' },
          slackHandle: { releaseContact: '@b' },
          jiraProject: ['ASSETS'],
        },
      },
      'jiraProject',
    );
    assert.equal(indexed.projectToLabel.ASSETS, 'team-a');
    assert.equal(indexed.warnings.length, 1);
  });
});

describe('action.yml', () => {
  it('exposes the shared interface and the safe defaults', () => {
    const action = parse(
      readFileSync(new URL('./action.yml', import.meta.url), 'utf8'),
    );
    assert.equal(action.runs.using, 'composite');
    const { inputs } = action;
    for (const name of [
      'mode',
      'platform',
      'github-token',
      'planning-token',
      'slack-bot-token',
      'jira-base-url',
      'jira-email',
      'jira-api-token',
      'jira-release-blocker-jql',
      'test-channel',
      'dry-run',
      'allow-pr-write',
    ]) {
      assert.ok(inputs[name], `missing input ${name}`);
    }
    assert.equal(inputs['dry-run'].default, 'true');
    assert.equal(inputs['allow-pr-write'].default, 'false');
    assert.equal(
      inputs['jira-base-url'].default,
      'https://consensyssoftware.atlassian.net',
    );
    assert.equal(inputs['jira-release-blocker-jql'].default, '');
    assert.equal(inputs['test-channel'].default, '');
    const runStep = action.runs.steps.find((step) =>
      String(step.run || '').includes('release-slack-summaries/run.mjs'),
    );
    assert.ok(runStep);
    const inputExpr = (name) => ['$', '{', '{ inputs.', name, ' }}'].join('');
    assert.equal(runStep.env.DRY_RUN, inputExpr('dry-run'));
    assert.equal(runStep.env.ALLOW_PR_WRITE, inputExpr('allow-pr-write'));
    assert.equal(
      runStep.env.JIRA_RELEASE_BLOCKER_JQL,
      inputExpr('jira-release-blocker-jql'),
    );
  });
});
