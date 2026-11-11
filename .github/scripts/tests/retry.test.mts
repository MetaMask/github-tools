import { expect, test } from 'vitest';

import { retry } from '../shared/retry.mts';

test('retries an operation with increasing delays', async () => {
  let attempts = 0;
  const delays: number[] = [];
  const result = await retry(
    async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error('Transient failure');
      }
      return 'recovered';
    },
    {
      delayMilliseconds: 100,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    },
  );

  expect(result).toBe('recovered');
  expect(attempts).toBe(3);
  expect(delays).toStrictEqual([100, 200]);
});

test('does not retry a rejected error category', async () => {
  let attempts = 0;
  await expect(
    (async () =>
      retry(
        async () => {
          attempts += 1;
          throw new Error('Permanent failure');
        },
        { shouldRetry: () => false },
      ))(),
  ).rejects.toThrow(/Permanent failure/u);

  expect(attempts).toBe(1);
});

test('reports retry details before delaying', async () => {
  const retries: { attempt: number; delayMilliseconds: number }[] = [];
  await expect(
    (async () =>
      retry(
        async () => {
          throw new Error('Transient failure');
        },
        {
          maxAttempts: 2,
          onRetry: ({ attempt, delayMilliseconds }) => {
            retries.push({ attempt, delayMilliseconds });
          },
          sleep: async () => undefined,
        },
      ))(),
  ).rejects.toThrow(/Transient failure/u);

  expect(retries).toStrictEqual([{ attempt: 1, delayMilliseconds: 1_000 }]);
});
