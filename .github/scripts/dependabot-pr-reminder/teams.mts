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
