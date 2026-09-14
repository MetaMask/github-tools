import type { Octokit } from '@octokit/rest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { generateSchemaDraft } from './generate';

const CATALOG = 'app/core/Analytics/MetaMetrics.events.ts';
const HOME = 'app/Home.ts';

const BASE_CATALOG = `
        enum EVENT_NAME {
          APP_OPENED = 'App Opened',
        }
      `;

const HEAD_CATALOG = `
        enum EVENT_NAME {
          APP_OPENED = 'App Opened',
          NEW_EVENT = 'New Event',
        }
      `;

const BASE_HOME = `
        createEventBuilder(MetaMetricsEvents.APP_OPENED).addProperties({ location: 'Home' });
      `;

const HEAD_HOME = `
        createEventBuilder(MetaMetricsEvents.APP_OPENED).addProperties({ location: 'Home' });
        createEventBuilder(MetaMetricsEvents.NEW_EVENT).addProperties({ source: 'banner' });
      `;

/**
 * Encodes a GitHub contents API file payload.
 *
 * @param text - File text.
 * @returns Octokit getContent shape.
 */
function encodedFile(text: string): { data: { content: string } } {
  return { data: { content: Buffer.from(text, 'utf8').toString('base64') } };
}

/**
 * Builds an Octokit mock for listFiles + getContent.
 *
 * @param contents - SHA → path → text.
 * @returns Mock Octokit.
 */
function mockClientOctokit(
  contents: Record<string, Record<string, string>>,
): Octokit {
  const paginate = jest.fn().mockResolvedValue([
    {
      filename: CATALOG,
      patch: "+NEW_EVENT = 'New Event'",
    },
    {
      filename: HOME,
      patch: '+createEventBuilder(MetaMetricsEvents.NEW_EVENT)',
    },
  ]);
  const getContent = jest
    .fn()
    .mockImplementation(
      async ({ path: filePath, ref }: { path: string; ref: string }) => {
        const text = contents[ref]?.[filePath];
        if (text === undefined) {
          const error: Error & { status: number } = Object.assign(
            new Error('Not Found'),
            { status: 404 },
          );
          return Promise.reject(error);
        }
        return Promise.resolve(encodedFile(text));
      },
    );

  return { paginate, repos: { getContent } } as unknown as Octokit;
}

describe('generateSchemaDraft', () => {
  it('writes unsorted YAML for a new catalog event and call-site property', async () => {
    const schemaDir = await fs.mkdtemp(path.join(os.tmpdir(), 'schema-'));
    await fs.mkdir(path.join(schemaDir, 'libraries/properties'), {
      recursive: true,
    });
    await fs.mkdir(path.join(schemaDir, 'tracking-plans'), { recursive: true });
    await fs.writeFile(
      path.join(schemaDir, 'libraries/properties/metamask-mobile-globals.yaml'),
      'properties:\n  anonymous:\n    type: boolean\n',
    );
    await fs.writeFile(
      path.join(schemaDir, 'tracking-plans/metamask-mobile.yaml'),
      'name: metamask-mobile\nlibraries:\n  - metamask-mobile-globals\n',
    );

    const octokit = mockClientOctokit({
      base: { [CATALOG]: BASE_CATALOG, [HOME]: BASE_HOME },
      head: { [CATALOG]: HEAD_CATALOG, [HOME]: HEAD_HOME },
    });

    const summary = await generateSchemaDraft({
      octokit,
      clientRepo: { owner: 'MetaMask', repo: 'metamask-mobile' },
      prNumber: 1,
      schemaDir,
      previousDir: undefined,
      platform: 'mobile',
      baseSha: 'base',
      headSha: 'head',
      branch: 'metamaskbot/mobile-pr-1',
      defaultLibrary: undefined,
    });

    expect(summary.hasChanges).toBe(true);
    expect(summary.changeset.eventsAdded).toStrictEqual([
      { enumKey: 'NEW_EVENT', eventName: 'New Event' },
    ]);
    const yaml = await fs.readFile(
      path.join(
        schemaDir,
        'libraries/events/metamask-mobile-unsorted/new-event.yaml',
      ),
      'utf8',
    );
    expect(yaml).toContain('name: New Event');
    expect(yaml).toContain('source:');

    await fs.rm(schemaDir, { recursive: true, force: true });
  });
});
