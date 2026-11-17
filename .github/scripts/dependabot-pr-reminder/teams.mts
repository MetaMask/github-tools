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
