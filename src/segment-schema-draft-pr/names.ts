/**
 * Converts a client camelCase property key to schema snake_case.
 *
 * @param key - Property key from TypeScript.
 * @returns The snake_case key.
 */
export function toSnakeCase(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/gu, '$1_$2')
    .toLowerCase();
}

/**
 * Converts an event display name to a YAML file slug.
 *
 * @param eventName - Segment event name, e.g. `App Opened`.
 * @returns The kebab-case file stem.
 */
export function toKebabSlug(eventName: string): string {
  return eventName
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '');
}
