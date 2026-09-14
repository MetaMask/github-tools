import type {
  AnalyticsChangeSet,
  AnalyticsModel,
  EventChange,
  PropertyChange,
  RemovedProperty,
  RenameChange,
} from './types';

/**
 * Diffs catalog + call-site models between PR base and head.
 *
 * @param base - Model at the base SHA.
 * @param head - Model at the head SHA.
 * @returns Additive changes plus listed-only removals/renames/unresolved.
 */
export function diffModels(
  base: AnalyticsModel,
  head: AnalyticsModel,
): AnalyticsChangeSet {
  const eventsAdded: EventChange[] = [];
  const eventsRemoved: EventChange[] = [];
  const eventsRenamed: RenameChange[] = [];

  for (const [enumKey, eventName] of head.catalog) {
    const baseName = base.catalog.get(enumKey);
    if (baseName === undefined) {
      eventsAdded.push({ enumKey, eventName });
      continue;
    }
    if (baseName !== eventName) {
      eventsRenamed.push({ enumKey, fromName: baseName, toName: eventName });
    }
  }

  for (const [enumKey, eventName] of base.catalog) {
    if (!head.catalog.has(enumKey)) {
      eventsRemoved.push({ enumKey, eventName });
    }
  }

  const renamedFrom = new Set(eventsRenamed.map((item) => item.fromName));
  const renamedTo = new Set(eventsRenamed.map((item) => item.toName));

  const propertiesAdded: PropertyChange[] = [];
  const propertiesRemoved: RemovedProperty[] = [];
  const typeChanges: PropertyChange[] = [];

  const eventNames = new Set([...base.events.keys(), ...head.events.keys()]);

  for (const eventName of eventNames) {
    if (renamedFrom.has(eventName) || renamedTo.has(eventName)) {
      continue;
    }

    const baseProps = base.events.get(eventName)?.properties ?? new Map();
    const headProps = head.events.get(eventName)?.properties ?? new Map();

    for (const [key, type] of headProps) {
      const previous = baseProps.get(key);
      if (previous === undefined) {
        propertiesAdded.push({ eventName, key, type });
        continue;
      }
      if (previous !== type) {
        typeChanges.push({ eventName, key, type });
      }
    }

    for (const key of baseProps.keys()) {
      if (!headProps.has(key)) {
        propertiesRemoved.push({ eventName, key });
      }
    }
  }

  const unresolved = [...head.events.values()].flatMap(
    (event) => event.unresolved,
  );

  return {
    eventsAdded,
    eventsRemoved,
    eventsRenamed,
    propertiesAdded,
    propertiesRemoved,
    typeChanges,
    unresolved,
  };
}

/**
 * True when the changeset has anything to show on the proposal or schema PR.
 *
 * @param changeset - Diff result.
 * @returns Whether a proposal (or schema write) is warranted.
 */
export function changesetHasContent(changeset: AnalyticsChangeSet): boolean {
  return (
    changeset.eventsAdded.length > 0 ||
    changeset.eventsRemoved.length > 0 ||
    changeset.eventsRenamed.length > 0 ||
    changeset.propertiesAdded.length > 0 ||
    changeset.propertiesRemoved.length > 0 ||
    changeset.typeChanges.length > 0 ||
    changeset.unresolved.length > 0
  );
}

/**
 * True when YAML should be written (additive events/properties only).
 *
 * @param changeset - Diff result.
 * @returns Whether apply-changes will mutate schema files.
 */
export function changesetHasWritableChanges(
  changeset: AnalyticsChangeSet,
): boolean {
  return (
    changeset.eventsAdded.length > 0 || changeset.propertiesAdded.length > 0
  );
}
