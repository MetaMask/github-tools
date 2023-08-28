import type { Json } from '@metamask/utils';
import fs from 'fs';
import path from 'path';

import { isErrorWithCode, wrapError } from './error-utils';

/**
 * Reads the file at the given path, assuming its content is encoded as UTF-8.
 *
 * @param filePath - The path to the file.
 * @returns The content of the file.
 * @throws An error with a stack trace if reading fails in any way.
 */
export async function readFile(filePath: string): Promise<string> {
  try {
    return await fs.promises.readFile(filePath, 'utf8');
  } catch (error) {
    throw wrapError(`Could not read file '${filePath}'`, error);
  }
}

/**
 * Writes content to the file at the given path.
 *
 * @param filePath - The path to the file.
 * @param content - The new content of the file.
 * @throws An error with a stack trace if writing fails in any way.
 */
export async function writeFile(
  filePath: string,
  content: string,
): Promise<void> {
  try {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, content);
  } catch (error) {
    throw wrapError(`Could not write file '${filePath}'`, error);
  }
}

/**
 * Reads the assumed JSON file at the given path, attempts to parse it, and
 * returns the resulting object.
 *
 * @param filePath - The path segments pointing to the JSON file. Will be passed
 * to path.join().
 * @returns The object corresponding to the parsed JSON file, typed against the
 * struct.
 * @throws An error with a stack trace if reading fails in any way, or if the
 * parsed value is not a plain object.
 */
export async function readJsonFile<Value extends Json>(
  filePath: string,
): Promise<Value> {
  try {
    const content = await readFile(filePath);
    return JSON.parse(content);
  } catch (error) {
    throw wrapError(`Could not read JSON file '${filePath}'`, error);
  }
}

/**
 * Attempts to write the given JSON-like value to the file at the given path.
 * Adds a newline to the end of the file.
 *
 * @param filePath - The path to write the JSON file to, including the file
 * itself.
 * @param jsonValue - The JSON-like value to write to the file. Make sure that
 * JSON.stringify can handle it.
 * @throws An error with a stack trace if writing fails in any way.
 */
export async function writeJsonFile(
  filePath: string,
  jsonValue: Json,
): Promise<void> {
  try {
    await writeFile(filePath, JSON.stringify(jsonValue, null, '  '));
  } catch (error) {
    throw wrapError(`Could not write JSON file '${filePath}'`, error);
  }
}

/**
 * Determines whether the given path refers to a file.
 *
 * @param entryPath - The path.
 * @returns The boolean result.
 */
export async function isFile(entryPath: string): Promise<boolean> {
  try {
    const stats = await fs.promises.stat(entryPath);
    return stats.isFile();
  } catch (error) {
    if (isErrorWithCode(error) && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}
