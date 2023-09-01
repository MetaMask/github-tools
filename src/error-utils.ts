import { isObject } from '@metamask/utils';

/**
 * Type guard for determining whether the given value is an instance of Error.
 * For errors generated via `fs.promises`, `error instanceof Error` won't work,
 * so we have to come up with another way of testing.
 *
 * @param error - The object to check.
 * @returns True or false, depending on the result.
 */
function isError(error: unknown): error is Error {
  return (
    error instanceof Error ||
    (isObject(error) && error.constructor.name === 'Error')
  );
}

/**
 * Type guard for determining whether the given value is an error object with a
 * `code` property such as the type of error that Node throws for filesystem
 * operations, etc.
 *
 * @param error - The object to check.
 * @returns True or false, depending on the result.
 */
export function isErrorWithCode(error: unknown): error is { code: string } {
  return typeof error === 'object' && error !== null && 'code' in error;
}

/**
 * Builds a new error object, linking to the original error via the `cause`
 * property if it is an Error.
 *
 * This function is useful to reframe error messages in general, but is
 * _critical_ when interacting with any of Node's filesystem functions as
 * provided via `fs.promises`, because these do not produce stack traces in the
 * case of an I/O error (see <https://github.com/nodejs/node/issues/30944>).
 *
 * @param message - The desired message of the new error.
 * @param originalError - The error that you want to cover (either an Error or
 * something throwable).
 * @returns A new error object.
 */
export function wrapError(message: string, originalError: unknown) {
  if (isError(originalError)) {
    const error = new Error(message, { cause: originalError });

    if (isErrorWithCode(originalError)) {
      // @ts-expect-error `code` is not a property on Error, even though Node
      // uses it.
      error.code = originalError.code;
    }

    return error;
  }

  // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
  return new Error(`${message}: ${originalError}`);
}
