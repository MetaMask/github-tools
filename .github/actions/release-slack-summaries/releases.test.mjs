import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { latestBuildFromComments, selectReleasePr } from './lib/release-pr.mjs';
import { selectReleases } from './lib/releases.mjs';

/**
 * Builds a pull request fixture for one version.
 *
 * @param {string} version - X.Y.Z.
 * @param {object} [overrides] - Pull fields.
 * @returns {object} A stable pull request.
 */
function pull(version, overrides = {}) {
  return {
    number: Number(version.replaceAll('.', '')),
    state: 'open',
    title: `Release: ${version}`,
    head: { ref: `release/${version}` },
    base: { ref: 'stable' },
    ...overrides,
  };
}

describe('selectReleases', () => {
  const pulls = [
    pull('13.9.0'),
    pull('13.10.0'),
    pull('13.53.1'),
    pull('13.52.0'),
    pull('13.51.0'),
    pull('13.50.0'),
    pull('13.49.0'),
    pull('13.53.0'),
    pull('13.48.0', { state: 'closed' }),
    pull('13.47.0', { base: { ref: 'main' } }),
    {
      state: 'open',
      title: 'Release: 13.46.0',
      head: { ref: 'release/v13.46.0' },
      base: { ref: 'stable' },
    },
  ];

  it('keeps the five newest release refs, including hotfixes, for the blocker summary', () => {
    const selected = selectReleases(pulls, { mode: 'blocker-summary' });
    assert.deepEqual(
      selected.map((item) => item.version),
      ['13.50.0', '13.51.0', '13.52.0', '13.53.0', '13.53.1'],
    );
  });

  it('keeps only x.y.0 releases for release validation', () => {
    const selected = selectReleases(pulls, { mode: 'release-validation' });
    assert.deepEqual(
      selected.map((item) => item.version),
      ['13.49.0', '13.50.0', '13.51.0', '13.52.0', '13.53.0'],
    );
  });
});

describe('selectReleasePr', () => {
  it('throws when the title is not exactly Release: V, and does not post', () => {
    assert.throws(
      () =>
        selectReleasePr(
          [
            {
              title: 'release: 13.53.0 (draft)',
              url: 'https://github.com/MetaMask/metamask-extension/pull/10',
            },
          ],
          '13.53.0',
          'metamask-extension',
        ),
      /does not have the expected title/u,
    );
  });

  it('accepts Release: V regardless of case', () => {
    const selected = selectReleasePr(
      [{ title: 'Release: 13.53.0', url: 'https://example.invalid/10' }],
      '13.53.0',
      'metamask-extension',
    );
    assert.equal(selected.title, 'Release: 13.53.0');
  });
});

describe('latestBuildFromComments', () => {
  it('uses the last metamaskbot Builds ready comment', () => {
    const older =
      '<a href="https://github.com/MetaMask/metamask-extension/releases/download/build-dist-browserify/builds/metamask-chrome-1.zip">';
    const newerChrome =
      '<a href="https://github.com/MetaMask/metamask-extension/releases/download/build-dist-browserify/builds/metamask-chrome-13.53.0.zip">';
    const newerFirefox =
      '<a href="https://github.com/MetaMask/metamask-extension/releases/download/build-dist-mv2-browserify/builds/metamask-firefox-13.53.0.zip">';
    const result = latestBuildFromComments(
      [
        {
          author: { login: 'metamaskbot' },
          body: `Builds ready ${older}`,
          url: 'https://example.invalid/1',
        },
        {
          author: { login: 'someone' },
          body: `Builds ready ${newerChrome}${newerFirefox}`,
          url: 'https://example.invalid/2',
        },
        {
          author: { login: 'metamaskbot' },
          body: `Builds ready ${newerChrome}${newerFirefox}`,
          url: 'https://example.invalid/3',
        },
      ],
      'Extension',
    );

    assert.equal(result.latestBuildCommentUrl, 'https://example.invalid/3');
    assert.equal(
      result.latestBuildCommentDownloadUrls.downloadUrl1,
      'https://github.com/MetaMask/metamask-extension/releases/download/build-dist-browserify/builds/metamask-chrome-13.53.0.zip',
    );
    assert.equal(
      result.latestBuildCommentDownloadUrls.downloadUrl2,
      'https://github.com/MetaMask/metamask-extension/releases/download/build-dist-mv2-browserify/builds/metamask-firefox-13.53.0.zip',
    );
  });
});
