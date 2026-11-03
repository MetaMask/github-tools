import { execFile } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { retry } from './shared/retry.mts';

const execFileAsync = promisify(execFile);

export type PullRequest = {
  number: number;
  title: string;
  url: string;
  requestedTeams: string[];
  hasApproval: boolean;
  ciFailing: boolean;
};

export type Reminder = {
  byTeam: Record<string, PullRequest[]>;
  fallback: {
    failingCi: PullRequest[];
    readyToMerge: PullRequest[];
    needsOwner: PullRequest[];
  };
};

/**
 * Normalizes a team reference to a bare lowercase slug.
 *
 * @param team - The team, e.g. `@MetaMask/Core-Platform`.
 * @returns The slug, e.g. `core-platform`.
 */
export function normalizeTeam(team: string): string {
  return team
    .trim()
    .toLowerCase()
    .replace(/^@/u, '')
    .replace(/^metamask\//u, '');
}

/**
 * Sorts pull requests into per-team groups and fallback buckets.
 *
 * Failing CI goes to the fallback bucket first, then PRs with remaining
 * requested teams are grouped by team, then approved PRs are ready to merge,
 * and anything else needs an owner.
 *
 * @param pullRequests - The open Dependabot pull requests.
 * @param options - Classification options.
 * @param options.ownerTeams - If set, only these teams are kept as owners.
 * @param options.fallbackTeam - The team that handles the fallback buckets.
 * @returns The classified reminder.
 */
export function classifyPullRequests(
  pullRequests: PullRequest[],
  options: { ownerTeams?: string[]; fallbackTeam: string },
): Reminder {
  const ownerTeams = options.ownerTeams?.map(normalizeTeam);
  const reminder: Reminder = {
    byTeam: {},
    fallback: { failingCi: [], readyToMerge: [], needsOwner: [] },
  };

  for (const pullRequest of pullRequests) {
    if (pullRequest.ciFailing) {
      reminder.fallback.failingCi.push(pullRequest);
      continue;
    }

    const teams = pullRequest.requestedTeams
      .map(normalizeTeam)
      .filter((team) => !ownerTeams || ownerTeams.includes(team));

    if (teams.length > 0) {
      for (const team of new Set(teams)) {
        (reminder.byTeam[team] ??= []).push(pullRequest);
      }
    } else if (pullRequest.hasApproval) {
      reminder.fallback.readyToMerge.push(pullRequest);
    } else {
      reminder.fallback.needsOwner.push(pullRequest);
    }
  }

  return reminder;
}

export type Topology = Record<
  string,
  { githubHandle?: string; slackHandle?: { team?: string } }
>;

/**
 * Escapes characters that Slack mrkdwn treats as control characters.
 *
 * @param text - The raw text.
 * @returns The escaped text.
 */
function escapeSlack(text: string): string {
  return text
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;');
}

/**
 * The maximum characters of a section text we emit. Slack rejects 3000+.
 */
const MAX_SECTION_LENGTH = 2800;

/**
 * Formats pull requests as bulleted Slack links, one line each.
 *
 * @param pullRequests - The pull requests to list.
 * @returns The bulleted lines.
 */
function formatPullRequestLines(pullRequests: PullRequest[]): string[] {
  return pullRequests.map(
    ({ url, number, title }) => `• <${url}|#${number} ${escapeSlack(title)}>`,
  );
}

/**
 * Splits a header and lines into section texts that fit Slack's limit. The
 * header is repeated on every section.
 *
 * @param header - The header line.
 * @param lines - The lines to list below the header.
 * @returns One or more section texts.
 */
function chunkSections(header: string, lines: string[]): string[] {
  const budget = Math.max(MAX_SECTION_LENGTH - header.length - 1, 1);
  const texts: string[] = [];
  let current: string[] = [];
  let length = 0;

  for (const rawLine of lines) {
    const line =
      rawLine.length > budget ? `${rawLine.slice(0, budget - 1)}…` : rawLine;
    const added = line.length + (current.length > 0 ? 1 : 0);
    if (current.length > 0 && length + added > budget) {
      texts.push(`${header}\n${current.join('\n')}`);
      current = [];
      length = 0;
    }
    length += line.length + (current.length > 0 ? 1 : 0);
    current.push(line);
  }
  if (current.length > 0) {
    texts.push(`${header}\n${current.join('\n')}`);
  }
  return texts;
}

/**
 * Builds the Slack incoming webhook payload for a reminder.
 *
 * @param reminder - The classified reminder.
 * @param topology - The team topology used to look up Slack user groups.
 * @param options - Payload options.
 * @param options.fallbackTeam - The team tagged on the fallback sections.
 * @param options.repository - The repository name shown in the header.
 * @returns The payload, or undefined when there is nothing to post.
 */
export function buildSlackPayload(
  reminder: Reminder,
  topology: Topology,
  options: { fallbackTeam: string; repository: string },
):
  | {
      text: string;
      // eslint-disable-next-line @typescript-eslint/naming-convention
      link_names: boolean;
      blocks: { type: string; text: { type: string; text: string } }[];
    }
  | undefined {
  const teamEntries = Object.entries(reminder.byTeam).filter(
    ([, pullRequests]) => pullRequests.length > 0,
  );
  const fallbackSections = [
    { label: 'Failing CI', pullRequests: reminder.fallback.failingCi },
    { label: 'Ready to merge', pullRequests: reminder.fallback.readyToMerge },
    { label: 'Needs owner', pullRequests: reminder.fallback.needsOwner },
  ].filter(({ pullRequests }) => pullRequests.length > 0);

  if (teamEntries.length === 0 && fallbackSections.length === 0) {
    return undefined;
  }

  const tag = (team: string): string => {
    const slug = normalizeTeam(team);
    const entry = Object.values(topology).find(
      ({ githubHandle }) =>
        githubHandle && normalizeTeam(githubHandle) === slug,
    );
    const id = entry?.slackHandle?.team;
    return id ? `<!subteam^${id}>` : slug;
  };

  const section = (text: string) => ({
    type: 'section',
    text: { type: 'mrkdwn', text },
  });

  const headline = `*[${escapeSlack(options.repository)}] Open Dependabot pull requests*`;
  const blocks = [section(headline)];
  const mentions = new Set<string>();
  const mention = (team: string): string => {
    const value = tag(team);
    if (value.startsWith('<!subteam^')) {
      mentions.add(value);
    }
    return value;
  };
  for (const [team, pullRequests] of teamEntries) {
    for (const text of chunkSections(
      mention(team),
      formatPullRequestLines(pullRequests),
    )) {
      blocks.push(section(text));
    }
  }
  for (const { label, pullRequests } of fallbackSections) {
    for (const text of chunkSections(
      `${mention(options.fallbackTeam)} *${label}*`,
      formatPullRequestLines(pullRequests),
    )) {
      blocks.push(section(text));
    }
  }

  return {
    text: [headline, ...mentions].join(' '),
    // eslint-disable-next-line @typescript-eslint/naming-convention
    link_names: true,
    blocks,
  };
}

export type GraphQlPullRequestNode = {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  author: { login: string } | null;
  reviewRequests: {
    nodes: {
      // eslint-disable-next-line @typescript-eslint/naming-convention
      requestedReviewer: { __typename: string; slug?: string } | null;
    }[];
  };
  latestOpinionatedReviews: { nodes: { state: string }[] };
  commits: {
    nodes: { commit: { statusCheckRollup: { state: string } | null } }[];
  };
};

/**
 * Maps a GraphQL pull request node to a PullRequest.
 *
 * @param node - The GraphQL node.
 * @returns The pull request, or undefined for drafts and non-Dependabot PRs.
 */
export function toPullRequest(
  node: GraphQlPullRequestNode,
): PullRequest | undefined {
  if (node.isDraft || node.author?.login !== 'dependabot[bot]') {
    return undefined;
  }

  const rollupState =
    node.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null;

  return {
    number: node.number,
    title: node.title,
    url: node.url,
    requestedTeams: node.reviewRequests.nodes.flatMap(
      ({ requestedReviewer }) =>
        requestedReviewer?.__typename === 'Team' && requestedReviewer.slug
          ? [requestedReviewer.slug]
          : [],
    ),
    hasApproval: node.latestOpinionatedReviews.nodes.some(
      ({ state }) => state === 'APPROVED',
    ),
    ciFailing: rollupState === 'FAILURE' || rollupState === 'ERROR',
  };
}

/**
 * Parses the comma-separated OWNER_TEAMS value.
 *
 * @param value - The raw value.
 * @returns The team list, or undefined when no teams are configured (so that
 * no filtering is applied).
 */
export function parseOwnerTeams(
  value: string | undefined,
): string[] | undefined {
  const teams = (value ?? '')
    .split(',')
    .map((team) => team.trim())
    .filter(Boolean);
  return teams.length > 0 ? teams : undefined;
}

const PULL_REQUESTS_QUERY = `
query($owner: String!, $name: String!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 100, after: $endCursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        title
        url
        isDraft
        author { login }
        reviewRequests(first: 20) {
          nodes { requestedReviewer { __typename ... on Team { slug } } }
        }
        latestOpinionatedReviews(first: 20) { nodes { state } }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`;

/**
 * Runs `gh api`, retrying transient failures.
 *
 * @param argumentsList - Arguments after `gh api`.
 * @param token - The token passed as GH_TOKEN, if different from the default.
 * @param environment - The base environment.
 * @returns The standard output.
 */
async function ghApi(
  argumentsList: string[],
  token: string | undefined,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  return await retry(
    async () => {
      const { stdout } = await execFileAsync('gh', ['api', ...argumentsList], {
        env: token ? { ...environment, GH_TOKEN: token } : environment,
        maxBuffer: 100 * 1024 * 1024,
      });
      return stdout;
    },
    { maxAttempts: 3, delayMilliseconds: 2_000 },
  );
}

/**
 * Fetches open Dependabot pull requests and writes the Slack payload.
 *
 * @param environment - The process environment.
 */
export async function main(environment: NodeJS.ProcessEnv): Promise<void> {
  const repository = environment.GITHUB_REPOSITORY;
  const fallbackTeam = environment.FALLBACK_TEAM;
  const planningToken = environment.PLANNING_TOKEN;
  const outputPath = environment.GITHUB_OUTPUT;
  if (!repository || !fallbackTeam || !planningToken || !outputPath) {
    throw new Error(
      'GITHUB_REPOSITORY, FALLBACK_TEAM, PLANNING_TOKEN and GITHUB_OUTPUT are required',
    );
  }
  const [owner, name] = repository.split('/');
  if (!owner || !name) {
    throw new Error('GITHUB_REPOSITORY must be in owner/name form');
  }
  const ref = environment.TOPOLOGY_REF?.trim()
    ? environment.TOPOLOGY_REF.trim()
    : 'main';

  const graphqlOutput = await ghApi(
    [
      'graphql',
      '--paginate',
      '--slurp',
      '-f',
      `query=${PULL_REQUESTS_QUERY}`,
      '-F',
      `owner=${owner}`,
      '-F',
      `name=${name}`,
    ],
    undefined,
    environment,
  );
  const pages = JSON.parse(graphqlOutput) as {
    data: { repository: { pullRequests: { nodes: GraphQlPullRequestNode[] } } };
  }[];
  const pullRequests = pages
    .flatMap((page) => page.data.repository.pullRequests.nodes)
    .map(toPullRequest)
    .filter((pullRequest): pullRequest is PullRequest => Boolean(pullRequest));

  const ownerTeams = parseOwnerTeams(environment.OWNER_TEAMS);
  const reminder = classifyPullRequests(pullRequests, {
    ...(ownerTeams ? { ownerTeams } : {}),
    fallbackTeam,
  });

  const topology = JSON.parse(
    await ghApi(
      [
        '-H',
        'Accept: application/vnd.github.raw',
        `repos/MetaMask/MetaMask-planning/contents/topology.json?ref=${ref}`,
      ],
      planningToken,
      environment,
    ),
  ) as Topology;

  const payload = buildSlackPayload(reminder, topology, {
    fallbackTeam,
    repository,
  });

  if (!payload) {
    console.log('No open Dependabot pull requests to report.');
    appendFileSync(outputPath, 'has-prs=false\n');
    return;
  }

  const payloadPath = join(
    environment.RUNNER_TEMP ?? '.',
    'dependabot-reminder-payload.json',
  );
  writeFileSync(payloadPath, JSON.stringify(payload));
  appendFileSync(outputPath, `has-prs=true\npayload-path=${payloadPath}\n`);
  console.log(`Wrote Slack payload with ${payload.blocks.length} sections.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.env).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
