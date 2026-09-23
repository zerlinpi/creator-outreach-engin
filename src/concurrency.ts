import { ConnectorError } from './errors.js';
export class AsyncSemaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly limit: number,
    private readonly maxQueued = 1024
  ) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Semaphore limit must be a positive integer.');
    if (!Number.isInteger(maxQueued) || maxQueued < 0 || maxQueued > 10_000) {
      throw new Error('Semaphore queue capacity must be an integer between 0 and 10000.');
    }
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      if (this.waiters.length >= this.maxQueued) {
        throw new ConnectorError('RATE_LIMITED', 'Too many concurrent operations are queued.');
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Concurrency must be a positive integer.');
  const results = new Array<R>(values.length);
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      results[index] = await mapper(values[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}
