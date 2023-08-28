import type { Json } from '@metamask/utils';

import { isFile, readJsonFile, writeJsonFile } from './fs-utils';
import { log } from './logging-utils';

type Cache<Data extends Json> = {
  ctime: string;
  data: Data;
};

/**
 * How long data retrieved from the GitHub API is cached.
 */
const DEFAULT_MAX_AGE = 60 * 60 * 1000; // 1 hour

/**
 * Avoids rate limits when making requests to an API by consulting a file cache.
 *
 * Reads the given cache file and returns the data within it if it exists and is
 * fresh enough; otherwise runs the given function and saves its return value to
 * the file.
 *
 * @param args - The arguments to this function.
 * @param args.filePath - The path to the file where the data should be saved.
 * @param args.getDataToCache - A function to get the data that should be cached
 * if the cache does not exist or is stale.
 * @param args.maxAge - The amount of time (in milliseconds) that the cache is
 * considered "fresh". Affects subsequent calls: if `fetchOrPopulateFileCache`
 * is called again with the same file path within the duration specified here,
 * `getDataToCache` will not get called again, otherwise it will.
 */
export async function fetchOrPopulateFileCache<Data extends Json>({
  filePath,
  getDataToCache,
  maxAge = DEFAULT_MAX_AGE,
}: {
  filePath: string;
  getDataToCache: () => Data | Promise<Data>;
  maxAge?: number;
}): Promise<Data> {
  const now = new Date();

  if (await isFile(filePath)) {
    const cache = await readJsonFile<Cache<Data>>(filePath);
    const createdDate = new Date(cache.ctime);

    if (now.getTime() - createdDate.getTime() <= maxAge) {
      log(`Reusing fresh cached data under ${filePath}`);
      return cache.data;
    }
  }

  log(
    `Cache does not exist or is stale; preparing data to write to ${filePath}`,
  );
  const dataToCache = await getDataToCache();
  await writeJsonFile(filePath, {
    ctime: now.toISOString(),
    data: dataToCache,
  });
  return dataToCache;
}
