import fs from 'fs/promises';
import path from 'path';
import { parseDocument } from 'yaml';

export type IndexedEvent = {
  name: string;
  filePath: string;
  library: string;
  defaultProps: string[];
  propertyKeys: Set<string>;
  propertyTypes: Map<string, string>;
};

export type SchemaIndex = {
  eventsByName: Map<string, IndexedEvent>;
  propertiesByLibrary: Map<string, Set<string>>;
};

/**
 * Indexes event YAML and property libraries under a schema checkout.
 *
 * @param schemaDir - Root of Consensys/segment-schema.
 * @returns Events by display name and default_props property sets.
 */
export async function buildSchemaIndex(
  schemaDir: string,
): Promise<SchemaIndex> {
  const eventsByName = new Map<string, IndexedEvent>();
  const propertiesByLibrary = new Map<string, Set<string>>();

  const eventsRoot = path.join(schemaDir, 'libraries', 'events');
  const eventFiles = await listYamlFiles(eventsRoot);

  for (const filePath of eventFiles) {
    const text = await fs.readFile(filePath, 'utf8');
    const doc = parseDocument(text);
    const name = asString(doc.get('name'));
    if (!name) {
      continue;
    }

    const relative = path.relative(schemaDir, filePath);
    const library = libraryFromEventPath(relative);
    const defaultProps = asStringSeq(doc.get('default_props'));
    const properties = doc.get('properties');
    const propertyKeys = new Set<string>();
    const propertyTypes = new Map<string, string>();

    if (isYamlMap(properties)) {
      for (const item of properties.items) {
        const key = asString(item.key);
        if (!key) {
          continue;
        }
        propertyKeys.add(key);
        const typeValue = isYamlMap(item.value)
          ? asString(item.value.get('type'))
          : undefined;
        if (typeValue) {
          propertyTypes.set(key, typeValue);
        }
      }
    }

    eventsByName.set(name, {
      name,
      filePath,
      library,
      defaultProps,
      propertyKeys,
      propertyTypes,
    });
  }

  const propertiesRoot = path.join(schemaDir, 'libraries', 'properties');
  const propertyFiles = await listYamlFiles(propertiesRoot);
  for (const filePath of propertyFiles) {
    const text = await fs.readFile(filePath, 'utf8');
    const doc = parseDocument(text);
    const library = path.basename(filePath, path.extname(filePath));
    const keys = new Set<string>();
    const properties = doc.get('properties');
    if (isYamlMap(properties)) {
      for (const item of properties.items) {
        const key = asString(item.key);
        if (key) {
          keys.add(key);
        }
      }
    }
    propertiesByLibrary.set(library, keys);
  }

  return { eventsByName, propertiesByLibrary };
}

/**
 * Property keys already supplied by an event's default_props libraries.
 *
 * @param index - Schema index.
 * @param defaultProps - Library ids listed on the event.
 * @returns Union of those libraries' keys.
 */
export function defaultPropKeys(
  index: SchemaIndex,
  defaultProps: string[],
): Set<string> {
  const keys = new Set<string>();
  for (const library of defaultProps) {
    const libraryKeys = index.propertiesByLibrary.get(library);
    if (!libraryKeys) {
      continue;
    }
    for (const key of libraryKeys) {
      keys.add(key);
    }
  }
  return keys;
}

/**
 * Recursively lists YAML files under a directory.
 *
 * @param dir - Directory to walk.
 * @returns Absolute file paths.
 */
async function listYamlFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    const { code } = error as { code?: string };
    if (code === 'ENOENT') {
      return results;
    }
    throw error;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await listYamlFiles(full)));
      continue;
    }
    if (
      entry.isFile() &&
      (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml'))
    ) {
      results.push(full);
    }
  }

  return results;
}

/**
 * Reads the library folder from `libraries/events/<library>/...`.
 *
 * @param relativePath - Path from the schema root.
 * @returns Library id.
 */
function libraryFromEventPath(relativePath: string): string {
  const parts = relativePath.split(path.sep);
  const eventsIndex = parts.indexOf('events');
  if (eventsIndex >= 0) {
    return parts[eventsIndex + 1] ?? '';
  }
  return '';
}

/**
 * Narrows a YAML node to a map.
 *
 * @param value - Parsed YAML node.
 * @returns Whether it is a YAML map.
 */
function isYamlMap(value: unknown): value is {
  items: { key: unknown; value: unknown }[];
  get: (key: string) => unknown;
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    'items' in value &&
    Array.isArray((value as { items: unknown }).items)
  );
}

/**
 * Reads a YAML scalar as a string.
 *
 * @param value - Parsed node.
 * @returns String, or undefined.
 */
function asString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (value && typeof value === 'object' && 'value' in value) {
    const inner = (value as { value: unknown }).value;
    if (typeof inner === 'string') {
      return inner;
    }
  }
  return undefined;
}

/**
 * Reads a YAML sequence of strings.
 *
 * @param value - Parsed node.
 * @returns String items.
 */
function asStringSeq(value: unknown): string[] {
  if (!value || typeof value !== 'object' || !('items' in value)) {
    return [];
  }
  const { items } = value as { items: unknown[] };
  const result: string[] = [];
  for (const item of items) {
    const text = asString(item);
    if (text) {
      result.push(text);
    }
  }
  return result;
}
