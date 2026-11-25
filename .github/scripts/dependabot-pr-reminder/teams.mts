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

/**
 * Parses the SHARED_TEAM_THRESHOLD value.
 *
 * @param value - The raw value.
 * @returns The threshold, or undefined to use the default.
 * @throws If the value is set but is not a positive whole number.
 */
export function parseSharedTeamThreshold(
  value: string | undefined,
): number | undefined {
  const trimmed = (value ?? '').trim();
  if (!trimmed) {
    return undefined;
  }
  const threshold = Number(trimmed);
  if (!Number.isInteger(threshold) || threshold < 1) {
    throw new Error('SHARED_TEAM_THRESHOLD must be a positive whole number');
  }
  return threshold;
}
