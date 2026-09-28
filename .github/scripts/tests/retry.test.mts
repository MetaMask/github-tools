import assert from 'node:assert/strict';
import test from 'node:test';

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

  assert.equal(result, 'recovered');
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [100, 200]);
});

test('does not retry a rejected error category', async () => {
  let attempts = 0;
  await assert.rejects(
    async () =>
      retry(
        async () => {
          attempts += 1;
          throw new Error('Permanent failure');
        },
        { shouldRetry: () => false },
      ),
    /Permanent failure/u,
  );

  assert.equal(attempts, 1);
});
