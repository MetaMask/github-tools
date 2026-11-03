import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_REGRESSION_JQL_BASE,
  buildBlockerJql,
  buildRegressionJql,
  projectScopedJql,
  searchJiraIssues,
  usesDefaultRegressionJql,
} from './lib/jira.mjs';

describe('JQL builders', () => {
  it('skips blockers when the filter JQL is empty and appends the release number when it is set', () => {
    assert.equal(buildBlockerJql('13.53.0', ''), null);
    assert.equal(buildBlockerJql('13.53.0', '   '), null);
    assert.equal(
      buildBlockerJql('13.53.0', 'filter = 12345'),
      'filter = 12345 AND cf[14565] = "13.53.0"',
    );
  });

  it('uses the proposal regression JQL until a caller overrides it', () => {
    assert.equal(usesDefaultRegressionJql(''), true);
    const jql = buildRegressionJql('13.53.1', '');
    assert.equal(
      jql,
      `${DEFAULT_REGRESSION_JQL_BASE} AND cf[16946] = "13.53.1"`,
    );
    assert.match(jql, /project in \(MUL, ASSETS,/u);
    assert.equal(
      buildRegressionJql('8.19.0', 'project = ASSETS'),
      'project = ASSETS AND cf[16946] = "8.19.0"',
    );
  });

  it('refuses to interpolate a release number that is not X.Y.Z', () => {
    assert.throws(() => buildBlockerJql('latest', 'filter = 1'), /unexpected/u);
    assert.throws(() => buildRegressionJql('13.53', ''), /unexpected/u);
  });

  it('scopes a team link by one project or by project in (...)', () => {
    assert.equal(projectScopedJql('filter = 1', []), 'filter = 1');
    assert.equal(
      projectScopedJql('filter = 1', ['ASSETS']),
      'filter = 1 AND project = ASSETS',
    );
    assert.equal(
      projectScopedJql('filter = 1', ['ASSETS', 'CEUX']),
      'filter = 1 AND project in (ASSETS, CEUX)',
    );
  });
});

describe('searchJiraIssues', () => {
  it('follows nextPageToken and stops on the last page', async () => {
    const seen = [];
    const fetchImpl = async (url, options) => {
      const body = JSON.parse(options.body);
      seen.push({ url, body, authorization: options.headers.Authorization });
      if (!body.nextPageToken) {
        return {
          ok: true,
          json: async () => ({
            issues: [{ key: 'ASSETS-1' }],
            nextPageToken: 'page-2',
            isLast: false,
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          issues: [{ key: 'ASSETS-2' }],
          isLast: true,
        }),
      };
    };

    const issues = await searchJiraIssues({
      baseUrl: 'https://consensyssoftware.atlassian.net/',
      email: 'victor@example.com',
      apiToken: 'secret-token',
      jql: 'issuetype = Bug',
      fetchImpl,
    });

    assert.deepEqual(
      issues.map((issue) => issue.key),
      ['ASSETS-1', 'ASSETS-2'],
    );
    assert.equal(seen.length, 2);
    assert.equal(
      seen[0].url,
      'https://consensyssoftware.atlassian.net/rest/api/3/search/jql',
    );
    assert.equal(seen[0].body.method, undefined);
    assert.equal(seen[0].body.jql, 'issuetype = Bug');
    assert.deepEqual(seen[0].body.fields, [
      'summary',
      'assignee',
      'project',
      'status',
    ]);
    assert.equal(seen[1].body.nextPageToken, 'page-2');
    assert.match(seen[0].authorization, /^Basic /u);
    assert.doesNotMatch(seen[0].authorization, /secret-token/u);
  });

  it('throws the status without the token when Jira rejects the search', async () => {
    const fetchImpl = async () => ({
      ok: false,
      status: 401,
      text: async () => 'auth failed secret-token',
    });

    await assert.rejects(
      () =>
        searchJiraIssues({
          baseUrl: 'https://consensyssoftware.atlassian.net',
          email: 'victor@example.com',
          apiToken: 'secret-token',
          jql: 'issuetype = Bug',
          fetchImpl,
        }),
      /Jira search failed \(401\): auth failed/u,
    );
  });
});
