import { Octokit } from '@octokit/rest';

import { OPT_OUT_LABEL, PROPOSAL_MARKER } from './constants';
import type { ResolvedClientPr, SchemaPr } from './types';

const PULL_NUMBER = 'pull_number';
const PER_PAGE = 'per_page';
const ISSUE_NUMBER = 'issue_number';
const COMMENT_ID = 'comment_id';

export type RepoId = {
  owner: string;
  repo: string;
};

/**
 * Parses `owner/repo` from an action input.
 *
 * @param fullName - `Consensys/segment-schema`.
 * @returns Owner and repo.
 */
export function parseRepo(fullName: string): RepoId {
  const [owner, repo] = fullName.split('/');
  if (!owner || !repo) {
    throw new Error(`Invalid repository: ${fullName}`);
  }
  return { owner, repo };
}

/**
 * Builds authenticated Octokit clients for the client PR and schema repo.
 *
 * @param githubToken - Token for Mobile/Extension.
 * @param schemaToken - GitHub App token for segment-schema.
 * @returns Two Octokit instances.
 */
export function createOctokitClients(
  githubToken: string,
  schemaToken: string,
): { client: Octokit; schema: Octokit } {
  return {
    client: new Octokit({ auth: githubToken }),
    schema: new Octokit({ auth: schemaToken }),
  };
}

/**
 * Loads the client pull request (needed on `issue_comment`).
 *
 * @param octokit - Client-repo Octokit.
 * @param repoId - Mobile or Extension repo.
 * @param prNumber - Pull request number.
 * @param currentRepository - `github.repository` of the workflow.
 * @returns Resolved SHAs, author, fork, labels, open/merged.
 */
export async function resolveClientPr(
  octokit: Octokit,
  repoId: RepoId,
  prNumber: number,
  currentRepository: string,
): Promise<ResolvedClientPr> {
  const { data } = await octokit.pulls.get({
    owner: repoId.owner,
    repo: repoId.repo,
    [PULL_NUMBER]: prNumber,
  });

  const labels = data.labels.map((label) => {
    return typeof label === 'string' ? label : (label.name ?? '');
  });

  const headRepoFullName = data.head.repo?.full_name ?? '';

  return {
    number: data.number,
    baseSha: data.base.sha,
    headSha: data.head.sha,
    authorLogin: data.user?.login ?? '',
    isOpen: data.state === 'open',
    merged: Boolean(data.merged),
    isFork: headRepoFullName !== currentRepository,
    hasOptOutLabel: labels.includes(OPT_OUT_LABEL),
    headRepoFullName,
  };
}

/**
 * Finds an open schema PR whose head is the bot branch.
 *
 * @param octokit - Schema-repo Octokit.
 * @param repoId - Schema repo.
 * @param branch - `metamaskbot/<platform>-pr-<N>`.
 * @returns Open PR, or null.
 */
export async function findOpenSchemaPr(
  octokit: Octokit,
  repoId: RepoId,
  branch: string,
): Promise<SchemaPr | null> {
  const { data } = await octokit.pulls.list({
    owner: repoId.owner,
    repo: repoId.repo,
    head: `${repoId.owner}:${branch}`,
    state: 'open',
    [PER_PAGE]: 5,
  });

  const match = data[0];
  if (!match) {
    return null;
  }

  return {
    number: match.number,
    htmlUrl: match.html_url,
    body: match.body ?? '',
    draft: Boolean(match.draft),
  };
}

/**
 * Creates a draft schema PR.
 *
 * @param octokit - Schema-repo Octokit.
 * @param repoId - Schema repo.
 * @param params - Branch, title, body, base.
 * @param params.branch - Bot branch name.
 * @param params.base - Schema base branch.
 * @param params.title - Pull request title.
 * @param params.body - Pull request body.
 * @returns Created PR.
 */
export async function createSchemaPr(
  octokit: Octokit,
  repoId: RepoId,
  params: { branch: string; base: string; title: string; body: string },
): Promise<SchemaPr> {
  const { data } = await octokit.pulls.create({
    owner: repoId.owner,
    repo: repoId.repo,
    head: params.branch,
    base: params.base,
    title: params.title,
    body: params.body,
    draft: true,
  });

  return {
    number: data.number,
    htmlUrl: data.html_url,
    body: data.body ?? '',
    draft: Boolean(data.draft),
  };
}

/**
 * Updates a schema PR body.
 *
 * @param octokit - Schema-repo Octokit.
 * @param repoId - Schema repo.
 * @param prNumber - Schema PR number.
 * @param body - Full body after splice.
 */
export async function updateSchemaPrBody(
  octokit: Octokit,
  repoId: RepoId,
  prNumber: number,
  body: string,
): Promise<void> {
  await octokit.pulls.update({
    owner: repoId.owner,
    repo: repoId.repo,
    [PULL_NUMBER]: prNumber,
    body,
  });
}

/**
 * Closes a schema PR.
 *
 * @param octokit - Schema-repo Octokit.
 * @param repoId - Schema repo.
 * @param prNumber - Schema PR number.
 */
export async function closeSchemaPr(
  octokit: Octokit,
  repoId: RepoId,
  prNumber: number,
): Promise<void> {
  await octokit.pulls.update({
    owner: repoId.owner,
    repo: repoId.repo,
    [PULL_NUMBER]: prNumber,
    state: 'closed',
  });
}

/**
 * Posts or edits the single proposal comment on the client PR.
 *
 * @param octokit - Client-repo Octokit.
 * @param repoId - Client repo.
 * @param prNumber - Client PR number.
 * @param body - New comment body (includes the proposal marker).
 */
export async function upsertProposalComment(
  octokit: Octokit,
  repoId: RepoId,
  prNumber: number,
  body: string,
): Promise<void> {
  const existing = await findProposalComment(octokit, repoId, prNumber);
  if (existing) {
    await octokit.issues.updateComment({
      owner: repoId.owner,
      repo: repoId.repo,
      [COMMENT_ID]: existing.id,
      body,
    });
    return;
  }

  await octokit.issues.createComment({
    owner: repoId.owner,
    repo: repoId.repo,
    [ISSUE_NUMBER]: prNumber,
    body,
  });
}

/**
 * Edits the sticky proposal comment when it already exists.
 *
 * Why: a later head with no analytics diff must not post a new "no longer
 * needed" comment on every pull request that never had a proposal.
 *
 * @param octokit - Client-repo Octokit.
 * @param repoId - Client repo.
 * @param prNumber - Client PR number.
 * @param body - New comment body (includes the proposal marker).
 * @returns Whether an existing proposal comment was updated.
 */
export async function updateProposalCommentIfExists(
  octokit: Octokit,
  repoId: RepoId,
  prNumber: number,
  body: string,
): Promise<boolean> {
  const existing = await findProposalComment(octokit, repoId, prNumber);
  if (!existing) {
    return false;
  }

  await octokit.issues.updateComment({
    owner: repoId.owner,
    repo: repoId.repo,
    [COMMENT_ID]: existing.id,
    body,
  });
  return true;
}

/**
 * Finds the sticky proposal comment on a client PR, if one was posted.
 *
 * @param octokit - Client-repo Octokit.
 * @param repoId - Client repo.
 * @param prNumber - Client PR number.
 * @returns The matching comment, or undefined.
 */
async function findProposalComment(
  octokit: Octokit,
  repoId: RepoId,
  prNumber: number,
): Promise<{ id: number } | undefined> {
  const comments = await octokit.paginate(
    'GET /repos/{owner}/{repo}/issues/{issue_number}/comments',
    {
      owner: repoId.owner,
      repo: repoId.repo,
      [ISSUE_NUMBER]: prNumber,
      [PER_PAGE]: 100,
    },
  );

  return comments.find((comment) => comment.body?.includes(PROPOSAL_MARKER));
}

/**
 * Posts a new (non-proposal) comment on a PR.
 *
 * @param octokit - Octokit for that repo.
 * @param repoId - Repo.
 * @param issueNumber - PR/issue number.
 * @param body - Markdown.
 */
export async function postComment(
  octokit: Octokit,
  repoId: RepoId,
  issueNumber: number,
  body: string,
): Promise<void> {
  await octokit.issues.createComment({
    owner: repoId.owner,
    repo: repoId.repo,
    [ISSUE_NUMBER]: issueNumber,
    body,
  });
}

/**
 * Loads the schema repo pull request template, if present.
 *
 * @param octokit - Schema-repo Octokit.
 * @param repoId - Schema repo.
 * @returns Template text, or empty string.
 */
export async function loadPrTemplate(
  octokit: Octokit,
  repoId: RepoId,
): Promise<string> {
  try {
    const { data } = await octokit.repos.getContent({
      owner: repoId.owner,
      repo: repoId.repo,
      path: '.github/pull-request-template.md',
    });
    if ('content' in data && data.content) {
      return Buffer.from(data.content, 'base64').toString('utf8');
    }
  } catch {
    return '';
  }
  return '';
}
