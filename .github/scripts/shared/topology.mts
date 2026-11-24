import { ghApi } from './github-cli.mts';
import type { GhOptions } from './github-cli.mts';

/** One team entry in MetaMask-planning's `topology.json`. */
export type TopologyTeam = {
  githubHandle?: string;
  githubLabel?: { name?: string };
  slackHandle?: { team?: string };
  members?: string[];
  pm?: string;
  em?: string;
  tl?: string;
};

/** The parsed `topology.json`, keyed by team. Entries can be null. */
export type Topology = Record<string, TopologyTeam | null>;

/**
 * Normalizes a team reference to a bare lowercase slug.
 *
 * @param team - The team, e.g. `@MetaMask/Core-Platform`.
 * @returns The slug, e.g. `core-platform`.
 */
export function normalizeTeamSlug(team: string): string {
  return team
    .trim()
    .toLowerCase()
    .replace(/^@/u, '')
    .replace(/^metamask\//u, '');
}

/**
 * Builds the REST path to read topology.json at a ref.
 *
 * @param ref - The git ref.
 * @returns The `gh api` path.
 */
export function buildTopologyPath(ref: string): string {
  return `repos/MetaMask/MetaMask-planning/contents/topology.json?ref=${encodeURIComponent(ref)}`;
}

/**
 * Fetches and parses topology.json with a single API call.
 *
 * @param options - Where to read it from.
 * @param options.ref - The MetaMask-planning ref. Defaults to `main`.
 * @param options.gh - Options for the underlying `gh api` call, including the
 * token with read access to MetaMask-planning.
 * @returns The parsed topology.
 * @throws If the response is not a JSON object.
 */
export async function fetchTopology({
  ref = 'main',
  gh,
}: {
  ref?: string;
  gh: GhOptions;
}): Promise<Topology> {
  const output = await ghApi(
    ['-H', 'Accept: application/vnd.github.raw', buildTopologyPath(ref)],
    gh,
  );
  const parsed: unknown = JSON.parse(output);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('topology.json is not a JSON object');
  }
  return parsed as Topology;
}

/**
 * Finds a team by its GitHub team slug, ignoring case, `@` and the org prefix.
 *
 * @param topology - The parsed topology.
 * @param slug - The team slug, e.g. `core-platform`.
 * @returns The team, or undefined when no entry matches.
 */
export function findTeamBySlug(
  topology: Topology,
  slug: string,
): TopologyTeam | undefined {
  const wanted = normalizeTeamSlug(slug);
  return Object.values(topology).find(
    (team): team is TopologyTeam =>
      typeof team?.githubHandle === 'string' &&
      normalizeTeamSlug(team.githubHandle) === wanted,
  );
}

/** A Slack user group handle, e.g. `@core-platform-team`. */
const SLACK_HANDLE_PATTERN = /^@[a-z0-9._-]+$/iu;

/**
 * Gets the Slack user group handle for a team. Slack turns the handle into a
 * mention when it appears in message text.
 *
 * @param topology - The parsed topology.
 * @param slug - The team slug.
 * @returns The handle with a leading `@`, or undefined when the team has none
 * or the value is not a plain handle. The check keeps markup such as
 * `<!channel>` out of messages.
 */
export function getSlackHandle(
  topology: Topology,
  slug: string,
): string | undefined {
  const value = findTeamBySlug(topology, slug)?.slackHandle?.team?.trim();
  if (!value) {
    return undefined;
  }
  const handle = value.startsWith('@') ? value : `@${value}`;
  return SLACK_HANDLE_PATTERN.test(handle) ? handle : undefined;
}

/**
 * Finds the teams a GitHub user belongs to, as a member, PM, EM or TL.
 *
 * @param topology - The parsed topology.
 * @param user - The GitHub login.
 * @returns The matching teams, in topology order.
 */
export function findTeamsByMember(
  topology: Topology,
  user: string,
): TopologyTeam[] {
  return Object.values(topology).filter(
    (team): team is TopologyTeam =>
      team !== null &&
      (team.members?.includes(user) === true ||
        team.pm === user ||
        team.em === user ||
        team.tl === user),
  );
}
