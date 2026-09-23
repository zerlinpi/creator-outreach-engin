import { describe, expect, it } from 'vitest';
import { AsyncSemaphore, mapWithConcurrency } from '../../src/concurrency.js';

describe('bounded concurrency primitives', () => {
  it('never exceeds the requested map concurrency', async () => {
    let active = 0;
    let highWater = 0;
    const results = await mapWithConcurrency(
      Array.from({ length: 12 }, (_, index) => index),
      3,
      async (value) => {
        active += 1;
        highWater = Math.max(highWater, active);
        await new Promise((resolve) => setTimeout(resolve, 3));
        active -= 1;
        return value * 2;
      }
    );
    expect(highWater).toBeLessThanOrEqual(3);
    expect(results).toEqual(Array.from({ length: 12 }, (_, index) => index * 2));
  });

  it('fails closed when the wait queue reaches its configured bound', async () => {
    const semaphore = new AsyncSemaphore(1, 1);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });

    const active = semaphore.run(async () => { await gate; });
    const queued = semaphore.run(async () => undefined);
    await expect(semaphore.run(async () => undefined)).rejects.toMatchObject({ code: 'RATE_LIMITED' });

    release();
    await Promise.all([active, queued]);
  });

  it('serializes operations when semaphore limit is one', async () => {
    const semaphore = new AsyncSemaphore(1);
    const order: string[] = [];
    await Promise.all([
      semaphore.run(async () => {
        order.push('a:start');
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push('a:end');
      }),
      semaphore.run(async () => {
        order.push('b:start');
        order.push('b:end');
      })
    ]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });
});
