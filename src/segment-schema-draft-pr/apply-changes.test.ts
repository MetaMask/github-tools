import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { applyChanges } from './apply-changes';
import { getPlatformConfig } from './config';
import { buildSchemaIndex } from './schema-index';
import type { AnalyticsChangeSet } from './types';

const MOBILE = getPlatformConfig('mobile');

const EXISTING_EVENT = `name: App Opened
description: "TODO: fill description"
type: TRACK
version: 1
labels:
  library: metamask-mobile-perps
default_props:
  - metamask-mobile-globals
properties:
  existing_prop:
    type: string
    description: "TODO: fill description"
    required: false
`;

const GLOBALS = `properties:
  anonymous:
    type: boolean
`;

const PLAN = `name: metamask-mobile
libraries:
  - metamask-mobile-globals
  - metamask-mobile-perps
`;

/**
 * Writes a nested file tree for schema fixtures.
 *
 * @param destDir - Directory to write into.
 * @param files - Map of relative paths to file contents.
 */
async function writeTree(
  destDir: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = path.join(destDir, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, contents);
  }
}

describe('schema-index and apply-changes', () => {
  let schemaDir: string;

  beforeEach(async () => {
    schemaDir = await fs.mkdtemp(path.join(os.tmpdir(), 'schema-'));
    await writeTree(schemaDir, {
      'libraries/events/metamask-mobile-perps/app-opened.yaml': EXISTING_EVENT,
      'libraries/properties/metamask-mobile-globals.yaml': GLOBALS,
      'tracking-plans/metamask-mobile.yaml': PLAN,
    });
  });

  afterEach(async () => {
    await fs.rm(schemaDir, { recursive: true, force: true });
  });

  it('indexes events by name and default_props keys', async () => {
    const index = await buildSchemaIndex(schemaDir);
    const event = index.eventsByName.get('App Opened');
    expect(event?.library).toBe('metamask-mobile-perps');
    expect(event?.propertyKeys.has('existing_prop')).toBe(true);
    expect(
      index.propertiesByLibrary
        .get('metamask-mobile-globals')
        ?.has('anonymous'),
    ).toBe(true);
  });

  it('patches existing events in place and creates unsorted events', async () => {
    const index = await buildSchemaIndex(schemaDir);
    const changeset: AnalyticsChangeSet = {
      eventsAdded: [{ enumKey: 'NEW_EVENT', eventName: 'New Event' }],
      eventsRemoved: [{ enumKey: 'GONE', eventName: 'Gone' }],
      eventsRenamed: [],
      propertiesAdded: [
        { eventName: 'App Opened', key: 'usd_value', type: 'number' },
        { eventName: 'App Opened', key: 'anonymous', type: 'boolean' },
        { eventName: 'New Event', key: 'source', type: 'string' },
      ],
      propertiesRemoved: [{ eventName: 'App Opened', key: 'old' }],
      typeChanges: [
        { eventName: 'App Opened', key: 'existing_prop', type: 'number' },
      ],
      unresolved: [{ eventName: 'New Event', key: 'helper', file: 'a.ts' }],
    };

    const result = await applyChanges(
      schemaDir,
      undefined,
      MOBILE,
      changeset,
      index,
    );
    expect(result.intendedFiles.map((file) => file.path)).toStrictEqual(
      expect.arrayContaining([
        'libraries/events/metamask-mobile-perps/app-opened.yaml',
        'libraries/events/metamask-mobile-unsorted/new-event.yaml',
      ]),
    );

    const updated = await fs.readFile(
      path.join(
        schemaDir,
        'libraries/events/metamask-mobile-perps/app-opened.yaml',
      ),
      'utf8',
    );
    expect(updated).toContain('usd_value');
    expect(updated).toContain('required: false');
    expect(updated).toMatch(/existing_prop:[\s\S]*type: string/u);
    expect(updated).not.toContain('anonymous:');

    const created = await fs.readFile(
      path.join(
        schemaDir,
        'libraries/events/metamask-mobile-unsorted/new-event.yaml',
      ),
      'utf8',
    );
    expect(created).toContain('name: New Event');
    expect(created).toContain('source:');
    expect(created).not.toContain('helper:');

    const plan = await fs.readFile(
      path.join(schemaDir, 'tracking-plans/metamask-mobile.yaml'),
      'utf8',
    );
    expect(plan).toContain('metamask-mobile-unsorted');
  });

  it('preserves non-TODO descriptions and labels.kpi from the previous bot branch', async () => {
    const previousDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prev-'));
    await writeTree(previousDir, {
      'libraries/events/metamask-mobile-unsorted/new-event.yaml': `name: New Event
description: Human written description
type: TRACK
version: 1
labels:
  library: metamask-mobile-unsorted
  kpi: true
properties:
  source:
    type: string
    description: Where the event came from
    required: false
`,
    });

    const index = await buildSchemaIndex(schemaDir);
    const changeset: AnalyticsChangeSet = {
      eventsAdded: [{ enumKey: 'NEW_EVENT', eventName: 'New Event' }],
      eventsRemoved: [],
      eventsRenamed: [],
      propertiesAdded: [
        { eventName: 'New Event', key: 'source', type: 'string' },
        { eventName: 'New Event', key: 'extra', type: 'boolean' },
      ],
      propertiesRemoved: [],
      typeChanges: [],
      unresolved: [],
    };

    await applyChanges(schemaDir, previousDir, MOBILE, changeset, index);
    const written = await fs.readFile(
      path.join(
        schemaDir,
        'libraries/events/metamask-mobile-unsorted/new-event.yaml',
      ),
      'utf8',
    );
    expect(written).toContain('Human written description');
    expect(written).toContain('kpi: true');
    expect(written).toContain('Where the event came from');
    expect(written).toContain('extra:');
    await fs.rm(previousDir, { recursive: true, force: true });
  });
});
