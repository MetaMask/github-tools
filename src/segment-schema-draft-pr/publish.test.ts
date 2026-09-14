import type { Octokit } from '@octokit/rest';

import { PROPOSAL_MARKER } from './constants';
import type { CliArgs } from './parse-args';
import { publishGenerateResult, publishTooManyFiles } from './publish';
import type { GenerateSummary } from './types';

const HTML_URL = 'html_url';
const COMMENT_ID = 'comment_id';

const EMPTY_CHANGESET = {
  eventsAdded: [],
  eventsRemoved: [],
  eventsRenamed: [],
  propertiesAdded: [],
  propertiesRemoved: [],
  typeChanges: [],
  unresolved: [],
};

const SUMMARY: GenerateSummary = {
  hasChanges: false,
  branch: 'metamaskbot/mobile-pr-12',
  changeset: EMPTY_CHANGESET,
  intendedFiles: [],
  schemaPrNumber: null,
  schemaPrUrl: null,
};

const ARGS: CliArgs = {
  phase: 'publish',
  mode: 'propose',
  platform: 'mobile',
  schema: '',
  previousDir: undefined,
  baseSha: 'base',
  headSha: 'head',
  prNumber: 12,
  clientRepository: 'MetaMask/metamask-mobile',
  segmentSchemaRepository: 'Consensys/segment-schema',
  segmentSchemaBase: 'main',
  githubToken: 'ghs_client',
  segmentSchemaToken: 'ghs_schema',
  dryRun: false,
  defaultLibrary: undefined,
  pushed: false,
  githubOutput: undefined,
  noAnalyticsDiff: false,
  tooManyFiles: false,
};

/**
 * Builds paired Octokit mocks for publishGenerateResult.
 *
 * @param params - List/paginate fixtures.
 * @param params.schemaPulls - Open schema PRs.
 * @param params.comments - Client PR comments.
 * @returns Client and schema Octokit plus spies.
 */
function mockOctokits(params: {
  schemaPulls: Record<string, unknown>[];
  comments: { id: number; body: string }[];
}): {
  client: Octokit;
  schema: Octokit;
  updateComment: jest.Mock;
  createComment: jest.Mock;
} {
  const updateComment = jest.fn().mockResolvedValue({});
  const createComment = jest.fn().mockResolvedValue({});
  const paginate = jest.fn().mockResolvedValue(params.comments);
  const client = {
    paginate,
    issues: { updateComment, createComment },
  } as unknown as Octokit;
  const schema = {
    pulls: {
      list: jest.fn().mockResolvedValue({ data: params.schemaPulls }),
    },
  } as unknown as Octokit;
  return { client, schema, updateComment, createComment };
}

describe('publishGenerateResult', () => {
  it('edits an existing proposal when propose has no schema PR and no changes', async () => {
    const { client, schema, updateComment, createComment } = mockOctokits({
      schemaPulls: [],
      comments: [{ id: 77, body: `${PROPOSAL_MARKER}\nold` }],
    });

    await publishGenerateResult({
      args: ARGS,
      summary: SUMMARY,
      client,
      schema,
    });

    expect(updateComment).toHaveBeenCalledWith(
      expect.objectContaining({
        [COMMENT_ID]: 77,
        body: expect.stringContaining('no longer has analytics changes'),
      }),
    );
    expect(createComment).not.toHaveBeenCalled();
  });

  it('does not post when propose has no schema PR, no changes, and no proposal comment', async () => {
    const { client, schema, updateComment, createComment } = mockOctokits({
      schemaPulls: [],
      comments: [],
    });

    await publishGenerateResult({
      args: ARGS,
      summary: SUMMARY,
      client,
      schema,
    });

    expect(updateComment).not.toHaveBeenCalled();
    expect(createComment).not.toHaveBeenCalled();
  });

  it('upserts the sticky stale comment and does not post a second thread', async () => {
    const { client, schema, updateComment, createComment } = mockOctokits({
      schemaPulls: [
        {
          number: 9,
          [HTML_URL]: 'https://github.com/Consensys/segment-schema/pull/9',
          body: 'body',
          draft: true,
        },
      ],
      comments: [{ id: 77, body: `${PROPOSAL_MARKER}\nold` }],
    });

    await publishGenerateResult({
      args: ARGS,
      summary: SUMMARY,
      client,
      schema,
    });

    expect(updateComment).toHaveBeenCalledWith(
      expect.objectContaining({
        [COMMENT_ID]: 77,
        body: expect.stringContaining(PROPOSAL_MARKER),
      }),
    );
    expect(updateComment.mock.calls[0]?.[0].body).toContain(
      'https://github.com/Consensys/segment-schema/pull/9',
    );
    expect(createComment).not.toHaveBeenCalled();
  });

  it('edits the sticky comment when the file cap is exceeded', async () => {
    const { client, schema, updateComment, createComment } = mockOctokits({
      schemaPulls: [],
      comments: [{ id: 77, body: `${PROPOSAL_MARKER}\nold` }],
    });

    await publishTooManyFiles({
      args: { ...ARGS, tooManyFiles: true },
      client,
      schema,
    });

    expect(updateComment).toHaveBeenCalledWith(
      expect.objectContaining({
        [COMMENT_ID]: 77,
        body: expect.stringContaining('more than 150'),
      }),
    );
    expect(createComment).not.toHaveBeenCalled();
  });
});
