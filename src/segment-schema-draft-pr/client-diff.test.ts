import type { Octokit } from '@octokit/rest';

import {
  getFileAtRef,
  hasAnalyticsDiff,
  loadPullRequestTsDiff,
} from './client-diff';

const PULL_NUMBER = 'pull_number';
const PER_PAGE = 'per_page';
const PREVIOUS_FILENAME = 'previous_filename';

const REPO = { owner: 'MetaMask', repo: 'metamask-mobile' };

describe('loadPullRequestTsDiff', () => {
  it('keeps non-test TypeScript paths from the PR file list', async () => {
    const paginate = jest.fn().mockResolvedValue([
      {
        filename: 'app/Home.ts',
        patch: '+createEventBuilder(MetaMetricsEvents.APP_OPENED)',
      },
      { filename: 'README.md', patch: '+docs' },
      { filename: 'app/foo.test.ts', patch: '+createEventBuilder(x)' },
      { filename: 'app/__tests__/bar.ts', patch: '+trackEvent' },
    ]);
    const octokit = { paginate } as unknown as Octokit;

    const diff = await loadPullRequestTsDiff(octokit, REPO, 12);

    expect(diff.files).toStrictEqual(['app/Home.ts']);
    expect(diff.mentionsAnalytics).toBe(true);
    expect(paginate).toHaveBeenCalledWith(
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/files',
      {
        owner: 'MetaMask',
        repo: 'metamask-mobile',
        [PULL_NUMBER]: 12,
        [PER_PAGE]: 100,
      },
    );
  });

  it('includes previous_filename so a rename is visible at both SHAs', async () => {
    const paginate = jest.fn().mockResolvedValue([
      {
        filename: 'app/track.tsx',
        [PREVIOUS_FILENAME]: 'app/old-track.tsx',
        patch: '+addProperties({ source: "banner" })',
      },
    ]);
    const octokit = { paginate } as unknown as Octokit;

    const diff = await loadPullRequestTsDiff(octokit, REPO, 12);

    expect(diff.files).toStrictEqual(['app/track.tsx', 'app/old-track.tsx']);
    expect(diff.mentionsAnalytics).toBe(true);
  });

  it('treats an omitted patch on a TypeScript file as an analytics hit', async () => {
    const paginate = jest.fn().mockResolvedValue([{ filename: 'app/Home.ts' }]);
    const octokit = { paginate } as unknown as Octokit;

    const diff = await loadPullRequestTsDiff(octokit, REPO, 12);

    expect(diff.files).toStrictEqual(['app/Home.ts']);
    expect(diff.mentionsAnalytics).toBe(true);
  });

  it('does not treat unrelated TypeScript patches as analytics hits', async () => {
    const paginate = jest
      .fn()
      .mockResolvedValue([
        { filename: 'app/Home.ts', patch: '+const x = 1;\n' },
      ]);
    const octokit = { paginate } as unknown as Octokit;

    const diff = await loadPullRequestTsDiff(octokit, REPO, 12);

    expect(diff.mentionsAnalytics).toBe(false);
  });
});

describe('hasAnalyticsDiff', () => {
  const catalog = 'app/core/Analytics/MetaMetrics.events.ts';
  const config = {
    catalogFile: catalog,
    enumName: 'EVENT_NAME',
    eventRefPrefix: 'MetaMetricsEvents',
    trackingPlan: 'tracking-plans/metamask-mobile.yaml',
    globals: 'metamask-mobile-globals',
    defaultLibrary: 'metamask-mobile-unsorted',
  };

  it('is true when the catalog file changed even without a prefilter hit', () => {
    expect(
      hasAnalyticsDiff({ files: [catalog], mentionsAnalytics: false }, config),
    ).toBe(true);
  });

  it('is false when neither the catalog nor analytics APIs appear', () => {
    expect(
      hasAnalyticsDiff(
        { files: ['app/Home.ts'], mentionsAnalytics: false },
        config,
      ),
    ).toBe(false);
  });
});

describe('getFileAtRef', () => {
  it('decodes base64 file contents', async () => {
    const getContent = jest.fn().mockResolvedValue({
      data: {
        content: Buffer.from('enum EVENT_NAME {}', 'utf8').toString('base64'),
      },
    });
    const octokit = { repos: { getContent } } as unknown as Octokit;

    expect(
      await getFileAtRef(
        octokit,
        REPO,
        'app/core/Analytics/MetaMetrics.events.ts',
        'abc',
      ),
    ).toBe('enum EVENT_NAME {}');
    expect(getContent).toHaveBeenCalledWith({
      owner: 'MetaMask',
      repo: 'metamask-mobile',
      path: 'app/core/Analytics/MetaMetrics.events.ts',
      ref: 'abc',
    });
  });

  it('returns null on 404', async () => {
    const error = new Error('Not Found') as Error & { status: number };
    error.status = 404;
    const getContent = jest.fn().mockRejectedValue(error);
    const octokit = { repos: { getContent } } as unknown as Octokit;

    expect(await getFileAtRef(octokit, REPO, 'app/gone.ts', 'abc')).toBeNull();
  });
});
