import type { Octokit } from '@octokit/rest';

import { OPT_OUT_LABEL, PROPOSAL_MARKER } from './constants';
import {
  createSchemaPr,
  findOpenSchemaPr,
  parseRepo,
  resolveClientPr,
  updateProposalCommentIfExists,
  upsertProposalComment,
} from './github-api';

const PULL_NUMBER = 'pull_number';
const PER_PAGE = 'per_page';
const COMMENT_ID = 'comment_id';
const HTML_URL = 'html_url';
const FULL_NAME = 'full_name';

describe('github-api', () => {
  it('parses owner/repo', () => {
    expect(parseRepo('Consensys/segment-schema')).toStrictEqual({
      owner: 'Consensys',
      repo: 'segment-schema',
    });
  });

  it('resolves the client PR including fork and opt-out label', async () => {
    const pullsGet = jest.fn().mockResolvedValue({
      data: {
        number: 12,
        base: { sha: 'base' },
        head: { sha: 'head', repo: { [FULL_NAME]: 'fork/mobile' } },
        user: { login: 'alice' },
        state: 'open',
        merged: false,
        labels: [{ name: OPT_OUT_LABEL }],
      },
    });
    const octokit = { pulls: { get: pullsGet } } as unknown as Octokit;

    const pr = await resolveClientPr(
      octokit,
      { owner: 'MetaMask', repo: 'metamask-mobile' },
      12,
      'MetaMask/metamask-mobile',
    );

    expect(pr.isFork).toBe(true);
    expect(pr.hasOptOutLabel).toBe(true);
    expect(pr.baseSha).toBe('base');
    expect(pr.headSha).toBe('head');
    expect(pullsGet).toHaveBeenCalledWith({
      owner: 'MetaMask',
      repo: 'metamask-mobile',
      [PULL_NUMBER]: 12,
    });
  });

  it('finds an open schema PR by bot head branch', async () => {
    const pullsList = jest.fn().mockResolvedValue({
      data: [
        {
          number: 9,
          [HTML_URL]: 'https://github.com/Consensys/segment-schema/pull/9',
          body: 'body',
          draft: true,
        },
      ],
    });
    const octokit = { pulls: { list: pullsList } } as unknown as Octokit;
    const found = await findOpenSchemaPr(
      octokit,
      { owner: 'Consensys', repo: 'segment-schema' },
      'metamaskbot/mobile-pr-12',
    );
    expect(found?.number).toBe(9);
    expect(pullsList).toHaveBeenCalledWith({
      owner: 'Consensys',
      repo: 'segment-schema',
      head: 'Consensys:metamaskbot/mobile-pr-12',
      state: 'open',
      [PER_PAGE]: 5,
    });
  });

  it('creates a draft schema PR', async () => {
    const pullsCreate = jest.fn().mockResolvedValue({
      data: {
        number: 3,
        [HTML_URL]: 'https://github.com/Consensys/segment-schema/pull/3',
        body: 'x',
        draft: true,
      },
    });
    const octokit = { pulls: { create: pullsCreate } } as unknown as Octokit;
    const created = await createSchemaPr(
      octokit,
      { owner: 'Consensys', repo: 'segment-schema' },
      {
        branch: 'metamaskbot/mobile-pr-12',
        base: 'main',
        title: 'Draft',
        body: 'body',
      },
    );
    expect(created.draft).toBe(true);
    expect(pullsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ draft: true }),
    );
  });

  it('edits the existing proposal comment instead of posting a second one', async () => {
    const paginate = jest
      .fn()
      .mockResolvedValue([{ id: 77, body: `${PROPOSAL_MARKER}\nold` }]);
    const updateComment = jest.fn().mockResolvedValue({});
    const createComment = jest.fn().mockResolvedValue({});
    const octokit = {
      paginate,
      issues: { updateComment, createComment },
    } as unknown as Octokit;

    await upsertProposalComment(
      octokit,
      { owner: 'MetaMask', repo: 'metamask-mobile' },
      12,
      `${PROPOSAL_MARKER}\nnew`,
    );
    expect(updateComment).toHaveBeenCalledWith({
      owner: 'MetaMask',
      repo: 'metamask-mobile',
      [COMMENT_ID]: 77,
      body: `${PROPOSAL_MARKER}\nnew`,
    });
    expect(createComment).not.toHaveBeenCalled();
  });

  it('updates an existing proposal comment and skips create', async () => {
    const paginate = jest
      .fn()
      .mockResolvedValue([{ id: 77, body: `${PROPOSAL_MARKER}\nold` }]);
    const updateComment = jest.fn().mockResolvedValue({});
    const createComment = jest.fn().mockResolvedValue({});
    const octokit = {
      paginate,
      issues: { updateComment, createComment },
    } as unknown as Octokit;

    const updated = await updateProposalCommentIfExists(
      octokit,
      { owner: 'MetaMask', repo: 'metamask-mobile' },
      12,
      `${PROPOSAL_MARKER}\nnew`,
    );
    expect(updated).toBe(true);
    expect(updateComment).toHaveBeenCalledWith({
      owner: 'MetaMask',
      repo: 'metamask-mobile',
      [COMMENT_ID]: 77,
      body: `${PROPOSAL_MARKER}\nnew`,
    });
    expect(createComment).not.toHaveBeenCalled();
  });

  it('no-ops when no proposal comment exists', async () => {
    const paginate = jest.fn().mockResolvedValue([]);
    const updateComment = jest.fn().mockResolvedValue({});
    const createComment = jest.fn().mockResolvedValue({});
    const octokit = {
      paginate,
      issues: { updateComment, createComment },
    } as unknown as Octokit;

    const updated = await updateProposalCommentIfExists(
      octokit,
      { owner: 'MetaMask', repo: 'metamask-mobile' },
      12,
      `${PROPOSAL_MARKER}\nnew`,
    );
    expect(updated).toBe(false);
    expect(updateComment).not.toHaveBeenCalled();
    expect(createComment).not.toHaveBeenCalled();
  });
});
