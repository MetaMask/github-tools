import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { jiraIssueToRcBug, mergeJiraIssues } from './lib/adapter.mjs';
import { indexTeams } from './lib/teams.mjs';

const BROWSE = 'https://consensyssoftware.atlassian.net';

/**
 * Reads one fixture shipped with this action.
 *
 * @param {string} name - Fixture file name.
 * @returns {string} File contents.
 */
function fixture(name) {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
}

describe('jiraIssueToRcBug', () => {
  it('maps an open unassigned issue and omits the team label when none is known', () => {
    const bug = jiraIssueToRcBug(
      {
        key: 'PRED-4',
        fields: {
          summary: 'Unmapped project blocker',
          assignee: null,
          project: { key: 'PRED' },
          status: { statusCategory: { key: 'new' } },
        },
      },
      { teamLabel: undefined, inBlockersSet: true, browseBaseUrl: BROWSE },
    );

    assert.deepEqual(bug, {
      key: 'PRED-4',
      projectKey: 'PRED',
      name: 'Unmapped project blocker',
      url: 'https://consensyssoftware.atlassian.net/browse/PRED-4',
      closed: 'false',
      assigneesLength: 0,
      labels: ['release-blocker'],
    });
  });

  it('marks Done issues closed and keeps a single team label', () => {
    const bug = jiraIssueToRcBug(
      {
        key: 'CEUX-3',
        fields: {
          summary: 'Closed regression',
          assignee: { displayName: 'Cy' },
          project: { key: 'CEUX' },
          status: { statusCategory: { key: 'done' } },
        },
      },
      {
        teamLabel: 'team-extension-platform',
        inBlockersSet: false,
        browseBaseUrl: `${BROWSE}/`,
      },
    );

    assert.equal(bug.closed, 'true');
    assert.equal(bug.assigneesLength, 1);
    assert.deepEqual(bug.labels, ['team-extension-platform']);
    assert.equal(
      bug.url,
      'https://consensyssoftware.atlassian.net/browse/CEUX-3',
    );
  });
});

describe('mergeJiraIssues', () => {
  it('dedupes by key and adds release-blocker only for the blocker set', () => {
    const issues = JSON.parse(fixture('jira-issues.json'));
    const { projectToLabel } = indexTeams(
      JSON.parse(fixture('topology.json')),
      'jiraProject',
    );
    const bugs = mergeJiraIssues(issues.regressions, issues.blockers, {
      teamLabelFor: (projectKey) => projectToLabel[projectKey],
      browseBaseUrl: BROWSE,
    });

    assert.deepEqual(
      bugs.map((bug) => bug.key),
      ['ASSETS-1', 'ASSETS-2', 'DSYS-9', 'PRED-4', 'CEUX-3'],
    );
    const login = bugs.find((bug) => bug.key === 'ASSETS-1');
    assert.deepEqual(login.labels, [
      'team-extension-platform',
      'release-blocker',
    ]);
    assert.equal(login.closed, 'false');
    assert.equal(login.assigneesLength, 0);
    const icon = bugs.find((bug) => bug.key === 'ASSETS-2');
    assert.deepEqual(icon.labels, ['team-extension-platform']);
    assert.equal(bugs.find((bug) => bug.key === 'PRED-4').projectKey, 'PRED');
    assert.equal(bugs.find((bug) => bug.key === 'CEUX-3').closed, 'true');
  });

  it('keeps a blocker that the regression search did not return', () => {
    const bugs = mergeJiraIssues(
      [],
      [
        {
          key: 'SWAPS-1',
          fields: {
            summary: 'Swap halt',
            assignee: { displayName: 'Dee' },
            project: { key: 'SWAPS' },
            status: { statusCategory: { key: 'indeterminate' } },
          },
        },
      ],
      {
        teamLabelFor: () => undefined,
        browseBaseUrl: BROWSE,
      },
    );

    assert.equal(bugs.length, 1);
    assert.deepEqual(bugs[0].labels, ['release-blocker']);
    assert.equal(bugs[0].projectKey, 'SWAPS');
  });
});
