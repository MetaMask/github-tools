import {
  changesetHasContent,
  changesetHasWritableChanges,
  diffModels,
} from './diff-models';
import type { AnalyticsModel } from './types';

/**
 * Builds a partial analytics model for diff tests.
 *
 * @param partial - Catalog and/or events to include.
 * @returns A complete analytics model.
 */
function model(partial: Partial<AnalyticsModel>): AnalyticsModel {
  return {
    catalog: partial.catalog ?? new Map(),
    events: partial.events ?? new Map(),
  };
}

describe('diffModels', () => {
  it('detects added, removed, and renamed catalog events', () => {
    const changeset = diffModels(
      model({
        catalog: new Map([
          ['KEEP', 'Keep'],
          ['GONE', 'Gone'],
          ['RENAME', 'Old Name'],
        ]),
      }),
      model({
        catalog: new Map([
          ['KEEP', 'Keep'],
          ['NEW', 'New Event'],
          ['RENAME', 'New Name'],
        ]),
      }),
    );

    expect(changeset.eventsAdded).toStrictEqual([
      { enumKey: 'NEW', eventName: 'New Event' },
    ]);
    expect(changeset.eventsRemoved).toStrictEqual([
      { enumKey: 'GONE', eventName: 'Gone' },
    ]);
    expect(changeset.eventsRenamed).toStrictEqual([
      { enumKey: 'RENAME', fromName: 'Old Name', toName: 'New Name' },
    ]);
  });

  it('detects added, removed, and type-changed properties', () => {
    const changeset = diffModels(
      model({
        events: new Map([
          [
            'App Opened',
            {
              properties: new Map([
                ['keep', 'string' as const],
                ['gone', 'string' as const],
                ['count', 'string' as const],
              ]),
              unresolved: [],
            },
          ],
        ]),
      }),
      model({
        events: new Map([
          [
            'App Opened',
            {
              properties: new Map([
                ['keep', 'string' as const],
                ['usd_value', 'number' as const],
                ['count', 'number' as const],
              ]),
              unresolved: [
                { eventName: 'App Opened', key: 'helper', file: 'a.ts' },
              ],
            },
          ],
        ]),
      }),
    );

    expect(changeset.propertiesAdded).toStrictEqual([
      { eventName: 'App Opened', key: 'usd_value', type: 'number' },
    ]);
    expect(changeset.propertiesRemoved).toStrictEqual([
      { eventName: 'App Opened', key: 'gone' },
    ]);
    expect(changeset.typeChanges).toStrictEqual([
      { eventName: 'App Opened', key: 'count', type: 'number' },
    ]);
    expect(changeset.unresolved).toHaveLength(1);
  });

  it('treats listed-only changes as content but not writable', () => {
    const listedOnly = {
      eventsAdded: [],
      eventsRemoved: [{ enumKey: 'GONE', eventName: 'Gone' }],
      eventsRenamed: [],
      propertiesAdded: [],
      propertiesRemoved: [],
      typeChanges: [],
      unresolved: [],
    };
    expect(changesetHasContent(listedOnly)).toBe(true);
    expect(changesetHasWritableChanges(listedOnly)).toBe(false);
  });
});
