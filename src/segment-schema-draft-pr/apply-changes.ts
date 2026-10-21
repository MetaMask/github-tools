import fs from 'fs/promises';
import path from 'path';
import { parseDocument, YAMLMap, Scalar } from 'yaml';
import type { Document } from 'yaml';

import { TODO_DESCRIPTION } from './constants';
import { uniqueKebabSlug } from './names';
import { defaultPropKeys, type SchemaIndex } from './schema-index';
import type {
  AnalyticsChangeSet,
  IntendedFileChange,
  PlatformConfig,
  PropertyChange,
  PropertyType,
} from './types';

export type ApplyResult = {
  intendedFiles: IntendedFileChange[];
  wroteLibraryToPlan: boolean;
};

/**
 * Writes additive YAML into the schema working tree.
 *
 * @param schemaDir - Schema checkout (usually `main`).
 * @param previousDir - Previous bot-branch checkout, if any.
 * @param config - Platform config.
 * @param changeset - Diff to apply.
 * @param index - Current schema index.
 * @returns Paths that were created or updated.
 */
export async function applyChanges(
  schemaDir: string,
  previousDir: string | undefined,
  config: PlatformConfig,
  changeset: AnalyticsChangeSet,
  index: SchemaIndex,
): Promise<ApplyResult> {
  const intendedFiles: IntendedFileChange[] = [];

  let wroteLibraryToPlan = false;
  const takenSlugs = await takenSlugsInLibrary(
    schemaDir,
    config.defaultLibrary,
  );
  const slugByEvent = assignEventSlugs(
    newEventNames(changeset, index),
    takenSlugs,
  );

  for (const [eventName, slug] of slugByEvent) {
    const relative = unsortedEventPath(config, slug);
    const properties = changeset.propertiesAdded.filter(
      (item) => item.eventName === eventName,
    );
    const absolute = path.join(schemaDir, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    const doc = buildNewEventDocument(eventName, config, properties);
    await preserveAndWrite(absolute, previousDir, relative, doc);
    intendedFiles.push({
      path: relative,
      kind: 'create',
      eventName,
    });
    wroteLibraryToPlan = true;
  }

  const propertiesByEvent = groupByEvent(changeset.propertiesAdded);
  for (const [eventName, properties] of propertiesByEvent) {
    const indexed = index.eventsByName.get(eventName);
    if (!indexed) {
      continue;
    }

    const supplied = defaultPropKeys(index, indexed.defaultProps);
    const toAdd = properties.filter((item) => {
      return !indexed.propertyKeys.has(item.key) && !supplied.has(item.key);
    });
    if (toAdd.length === 0) {
      continue;
    }

    const text = await fs.readFile(indexed.filePath, 'utf8');
    const doc = parseDocument(text);
    appendProperties(doc, toAdd);
    const relative = path.relative(schemaDir, indexed.filePath);
    await preserveAndWrite(indexed.filePath, previousDir, relative, doc);
    intendedFiles.push({ path: relative, kind: 'update', eventName });
  }

  if (wroteLibraryToPlan) {
    const attached = await attachLibraryToPlan(schemaDir, config);
    wroteLibraryToPlan = attached;
  }

  return { intendedFiles, wroteLibraryToPlan };
}

/**
 * Path of a new event in the platform unsorted library.
 *
 * @param config - Platform config.
 * @param slug - Filename stem.
 * @returns Path relative to the schema root.
 */
function unsortedEventPath(config: PlatformConfig, slug: string): string {
  return path.join(
    'libraries',
    'events',
    config.defaultLibrary,
    `${slug}.yaml`,
  );
}

/**
 * Event names that need a new YAML file.
 *
 * @param changeset - Diff to apply.
 * @param index - Current schema index.
 * @returns Names in changeset order, each once.
 */
function newEventNames(
  changeset: AnalyticsChangeSet,
  index: SchemaIndex,
): string[] {
  const names: string[] = [];
  const seen = new Set<string>();

  const consider = (eventName: string) => {
    if (seen.has(eventName) || index.eventsByName.has(eventName)) {
      return;
    }
    seen.add(eventName);
    names.push(eventName);
  };

  for (const event of changeset.eventsAdded) {
    consider(event.eventName);
  }
  for (const property of changeset.propertiesAdded) {
    consider(property.eventName);
  }

  return names;
}

/**
 * Assigns a unique kebab stem to each new event.
 *
 * Names are sorted first so the same set of events always maps to the
 * same files. `Foo Bar` sorts before `Foo-Bar` and keeps `foo-bar`; the
 * other name receives `foo-bar-2`.
 *
 * @param eventNames - New event display names.
 * @param taken - Stems already used in the library. This set is updated.
 * @returns Event name to filename stem.
 */
function assignEventSlugs(
  eventNames: readonly string[],
  taken: Set<string>,
): Map<string, string> {
  const assigned = new Map<string, string>();
  for (const eventName of [...eventNames].sort()) {
    const slug = uniqueKebabSlug(eventName, taken);
    taken.add(slug);
    assigned.set(eventName, slug);
  }
  return assigned;
}

/**
 * Filename stems already present in a library directory.
 *
 * @param schemaDir - Schema checkout.
 * @param library - Library id under `libraries/events`.
 * @returns Stems of `*.yaml` files in that directory.
 */
async function takenSlugsInLibrary(
  schemaDir: string,
  library: string,
): Promise<Set<string>> {
  const dir = path.join(schemaDir, 'libraries', 'events', library);
  let filenames: string[];
  try {
    filenames = await fs.readdir(dir);
  } catch (error) {
    const { code } = error as { code?: string };
    if (code === 'ENOENT') {
      return new Set();
    }
    throw error;
  }

  const taken = new Set<string>();
  for (const filename of filenames) {
    const stem = stemFromYamlFilename(filename);
    if (stem !== undefined) {
      taken.add(stem);
    }
  }
  return taken;
}

/**
 * Stem of a top-level event YAML filename.
 *
 * @param filename - Directory entry name.
 * @returns The filename stem.
 */
function stemFromYamlFilename(filename: string): string | undefined {
  if (!filename.endsWith('.yaml')) {
    return undefined;
  }
  return filename.slice(0, -'.yaml'.length);
}

/**
 * Builds a new unsorted-library event document.
 *
 * @param eventName - Display name.
 * @param config - Platform config.
 * @param properties - Additive properties.
 * @returns YAML document.
 */
function buildNewEventDocument(
  eventName: string,
  config: PlatformConfig,
  properties: PropertyChange[],
): Document {
  const doc = parseDocument(
    [
      'name: ""',
      `description: ${JSON.stringify(TODO_DESCRIPTION)}`,
      'type: TRACK',
      'version: 1',
      'labels:',
      `  library: ${config.defaultLibrary}`,
      'default_props:',
      `  - ${config.globals}`,
      'properties: {}',
    ].join('\n'),
  );
  doc.set('name', quotedScalar(eventName));
  appendProperties(doc, properties);
  return doc;
}

/**
 * Appends properties with required: false and TODO descriptions.
 *
 * @param doc - Event YAML document.
 * @param properties - Properties to add.
 */
function appendProperties(doc: Document, properties: PropertyChange[]): void {
  const map = ensurePropertiesMap(doc);
  for (const property of properties) {
    if (map.has(property.key)) {
      continue;
    }
    const prop = new YAMLMap();
    prop.set('type', yamlType(property.type));
    prop.set('description', quotedScalar(TODO_DESCRIPTION));
    prop.set('required', false);
    map.set(property.key, prop);
  }
}

/**
 * Quotes a scalar so values like `TODO: ...` stay valid YAML.
 *
 * @param value - String to quote.
 * @returns Double-quoted YAML scalar.
 */
function quotedScalar(value: string): Scalar {
  const scalar = new Scalar(value);
  scalar.type = Scalar.QUOTE_DOUBLE;
  return scalar;
}

/**
 * Ensures the event document has a YAML map at `properties`.
 *
 * @param doc - Event YAML document.
 * @returns Properties map.
 */
function ensurePropertiesMap(doc: Document): YAMLMap {
  const current = doc.get('properties');
  if (current instanceof YAMLMap) {
    current.flow = false;
    return current;
  }
  const map = new YAMLMap();
  map.flow = false;
  doc.set('properties', map);
  return map;
}

/**
 * Maps inferred types onto Segment YAML type names.
 *
 * @param type - Syntactic type.
 * @returns YAML `type` value.
 */
function yamlType(type: PropertyType): string {
  return type;
}

/**
 * Copies human-edited descriptions and labels.kpi from the previous bot branch.
 *
 * @param absolute - File to write in the main checkout.
 * @param previousDir - Previous bot-branch root.
 * @param relative - Path from schema root.
 * @param doc - Document about to be written.
 */
async function preserveAndWrite(
  absolute: string,
  previousDir: string | undefined,
  relative: string,
  doc: Document,
): Promise<void> {
  if (previousDir) {
    const previousPath = path.join(previousDir, relative);
    try {
      const previousText = await fs.readFile(previousPath, 'utf8');
      const previous = parseDocument(previousText);
      overlayPreservedFields(doc, previous);
    } catch (error) {
      const { code } = error as { code?: string };
      if (code !== 'ENOENT') {
        throw error;
      }
    }
  }

  await fs.writeFile(absolute, String(doc));
}

/**
 * Keeps non-TODO descriptions and labels.kpi from a previous version of the file.
 *
 * @param next - Newly generated document.
 * @param previous - Document from the last bot branch.
 */
function overlayPreservedFields(next: Document, previous: Document): void {
  if (yamlKey(previous.get('name')) !== yamlKey(next.get('name'))) {
    return;
  }

  const previousDescription = previous.get('description');
  if (isNonTodoDescription(previousDescription)) {
    next.set('description', previousDescription);
  }

  const previousKpi = previous.getIn(['labels', 'kpi']);
  if (previousKpi !== undefined && previousKpi !== null) {
    next.setIn(['labels', 'kpi'], previousKpi);
  }

  const previousProperties = previous.get('properties');
  const nextProperties = next.get('properties');
  if (!isYamlMap(previousProperties) || !isYamlMap(nextProperties)) {
    return;
  }

  for (const item of previousProperties.items) {
    const key = yamlKey(item.key);
    if (!key || next.getIn(['properties', key]) === undefined) {
      continue;
    }
    const previousProp = item.value;
    if (!isYamlMap(previousProp)) {
      continue;
    }
    const description = previousProp.get('description');
    if (isNonTodoDescription(description)) {
      next.setIn(['properties', key, 'description'], description);
    }
  }
}

/**
 * Appends the unsorted library id to the platform tracking plan if missing.
 *
 * @param schemaDir - Schema root.
 * @param config - Platform config.
 * @returns Whether the plan file was updated.
 */
async function attachLibraryToPlan(
  schemaDir: string,
  config: PlatformConfig,
): Promise<boolean> {
  const planPath = path.join(schemaDir, config.trackingPlan);
  const text = await fs.readFile(planPath, 'utf8');
  const doc = parseDocument(text);
  const libraries = doc.get('libraries');
  if (!isYamlSeq(libraries)) {
    return false;
  }

  const existing = libraries.items.map((item) => yamlKey(item));
  if (existing.includes(config.defaultLibrary)) {
    return false;
  }

  libraries.add(config.defaultLibrary);
  await fs.writeFile(planPath, String(doc));
  return true;
}

/**
 * Groups property changes by event name.
 *
 * @param properties - Flat list.
 * @returns Map of event name to properties.
 */
function groupByEvent(
  properties: PropertyChange[],
): Map<string, PropertyChange[]> {
  const grouped = new Map<string, PropertyChange[]>();
  for (const property of properties) {
    const list = grouped.get(property.eventName) ?? [];
    list.push(property);
    grouped.set(property.eventName, list);
  }
  return grouped;
}

/**
 * True when a description is a human-written string, not the TODO placeholder.
 *
 * @param value - YAML node.
 * @returns Whether to preserve it.
 */
function isNonTodoDescription(value: unknown): boolean {
  const text = yamlKey(value);
  return Boolean(text && text !== TODO_DESCRIPTION && !text.startsWith('TODO'));
}

/**
 * Reads a YAML scalar or node as a string.
 *
 * @param value - YAML node.
 * @returns String text.
 */
function yamlKey(value: unknown): string | undefined {
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
 * Narrows a YAML map.
 *
 * @param value - Parsed node.
 * @returns Whether it is a map with items.
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
 * Narrows a YAML sequence.
 *
 * @param value - Parsed node.
 * @returns Whether it is a sequence with add().
 */
function isYamlSeq(
  value: unknown,
): value is { items: unknown[]; add: (item: string) => void } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'items' in value &&
    'add' in value &&
    typeof (value as { add: unknown }).add === 'function'
  );
}
