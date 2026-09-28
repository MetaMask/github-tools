export type RetryOptions = {
  delayMilliseconds?: number;
  maxAttempts?: number;
  shouldRetry?: (error: unknown) => boolean;
  sleep?: (milliseconds: number) => Promise<void>;
};

async function defaultSleep(milliseconds: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

export async function retry<Result>(
  operation: () => Promise<Result>,
  {
    delayMilliseconds = 1_000,
    maxAttempts = 3,
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
      await sleep(delayMilliseconds * attempt);
    }
  }

  throw new Error('Retry attempts exhausted');
}
