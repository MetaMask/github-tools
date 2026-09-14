/**
 * Returns the process environment map.
 *
 * @returns The current process environment.
 */
export function getProcessEnv(): NodeJS.ProcessEnv {
  // This function is designed to access `process.env`.
  // eslint-disable-next-line n/no-process-env
  return process.env;
}

/**
 * Retrieves the value of an environment variable, throwing if it doesn't exist.
 *
 * @param name - The property in `process.env` you want to retrieve.
 * @throws If the given environment variable has not been set.
 * @returns The value of the environment variable.
 */
export function getRequiredEnvironmentVariable(name: string): string {
  const value = getProcessEnv()[name];

  if (value === undefined) {
    throw new Error(`Must set ${name}`);
  }

  return value;
}
