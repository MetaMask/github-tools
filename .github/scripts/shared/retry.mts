/** Options for `retry`. */
export type RetryOptions = {
  delayMilliseconds?: number;
  maxAttempts?: number;
  onRetry?: (details: {
    attempt: number;
    delayMilliseconds: number;
    error: unknown;
  }) => void;
  shouldRetry?: (error: unknown) => boolean;
  sleep?: ((milliseconds: number) => Promise<void>) | undefined;
};

/**
 * Waits for a number of milliseconds.
 *
 * @param milliseconds - How long to wait.
 */
async function defaultSleep(milliseconds: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

/**
 * Runs an operation, retrying failures with a linearly growing delay.
 *
 * @param operation - The operation to run.
 * @param options - Retry behavior.
 * @param options.delayMilliseconds - The base delay, multiplied by the attempt.
 * @param options.maxAttempts - The total number of attempts.
 * @param options.onRetry - Called before each delay.
 * @param options.shouldRetry - Returns false to rethrow without retrying.
 * @param options.sleep - Waits between attempts; replaced in tests.
 * @returns The operation's result.
 * @throws The last error, once attempts run out or `shouldRetry` declines.
 */
export async function retry<Result>(
  operation: () => Promise<Result>,
  {
    delayMilliseconds = 1_000,
    maxAttempts = 3,
    onRetry,
    shouldRetry = () => true,
    sleep = defaultSleep,
  }: RetryOptions = {},
): Promise<Result> {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('maxAttempts must be a positive integer');
  }
  if (!Number.isFinite(delayMilliseconds) || delayMilliseconds < 0) {
    throw new Error('delayMilliseconds must be a non-negative number');
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === maxAttempts || !shouldRetry(error)) {
        throw error;
      }
      const retryDelayMilliseconds = delayMilliseconds * attempt;
      onRetry?.({
        attempt,
        delayMilliseconds: retryDelayMilliseconds,
        error,
      });
      await sleep(retryDelayMilliseconds);
    }
  }

  throw new Error('Retry attempts exhausted');
}
