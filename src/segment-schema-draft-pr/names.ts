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

const MAX_KEBAB_SUFFIX = 99;

/**
 * Picks a kebab filename stem that no other event file is using.
 *
 * `Foo Bar` and `Foo-Bar` both slug to `foo-bar`. The plain slug is used
 * when it is free. Otherwise the smallest numeric suffix that is free is
 * used (`foo-bar-2`).
 *
 * @param eventName - Segment event display name.
 * @param taken - Stems already used in the target library.
 * @returns A unique kebab stem.
 */
export function uniqueKebabSlug(
  eventName: string,
  taken: ReadonlySet<string>,
): string {
  const base = toKebabSlug(eventName) || 'event';
  if (!taken.has(base)) {
    return base;
  }

  for (let suffix = 2; suffix <= MAX_KEBAB_SUFFIX; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }

  throw new Error(`No free schema filename for event "${eventName}"`);
}
