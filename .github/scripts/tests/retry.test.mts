import { describe, expect, it, vi } from 'vitest';

import { retry } from '../shared/retry.mts';

describe('retry', () => {
  it('retries an operation with increasing delays', async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('Transient failure'))
      .mockRejectedValueOnce(new Error('Transient failure'))
      .mockResolvedValue('recovered');
    const delays: number[] = [];
    const result = await retry(operation, {
      delayMilliseconds: 100,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });

    expect(result).toBe('recovered');
    expect(operation).toHaveBeenCalledTimes(3);
    expect(delays).toStrictEqual([100, 200]);
  });

  it('does not retry a rejected error category', async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new Error('Permanent failure'));
    await expect(
      retry(operation, { shouldRetry: () => false }),
    ).rejects.toThrow(/Permanent failure/u);

    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('reports retry details before delaying', async () => {
    const retries: { attempt: number; delayMilliseconds: number }[] = [];
    await expect(
      retry(
        async (): Promise<string> => {
          throw new Error('Transient failure');
        },
        {
          maxAttempts: 2,
          onRetry: ({ attempt, delayMilliseconds }) => {
            retries.push({ attempt, delayMilliseconds });
          },
          sleep: async () => undefined,
        },
      ),
    ).rejects.toThrow(/Transient failure/u);

    expect(retries).toStrictEqual([{ attempt: 1, delayMilliseconds: 1_000 }]);
  });
});
