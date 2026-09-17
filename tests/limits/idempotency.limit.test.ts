import { describe, expect, it } from 'vitest';
import { ConnectorError } from '../../src/errors.js';
import { IdempotencyStore } from '../../src/mail/idempotency.js';

describe('idempotency capacity limits', () => {
  it('admits the default 1000 protected keys and fails closed on the 1001st while entries are unexpired', async () => {
    const store = new IdempotencyStore();
    const operations = Array.from({ length: 1000 }, (_, index) =>
      store.execute(`key-${index}`, { index }, async () => index)
    );

    await expect(Promise.all(operations)).resolves.toHaveLength(1000);
    expect(store.size).toBe(1000);
    await expect(store.execute('key-1000', { index: 1000 }, async () => 1000))
      .rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(store.size).toBe(1000);
  });

  it('collapses 1000 concurrent replays of one key into exactly one underlying operation', async () => {
    const store = new IdempotencyStore();
    let executions = 0;
    const operation = async () => {
      executions += 1;
      await new Promise<void>((resolve) => setImmediate(resolve));
      return { delivered: true };
    };

    const results = await Promise.all(
      Array.from({ length: 1000 }, () => store.execute('same-key', { creator: 'a@example.com' }, operation))
    );

    expect(executions).toBe(1);
    expect(results).toHaveLength(1000);
    expect(results.every((value) => value.delivered)).toBe(true);
    expect(store.size).toBe(1);
  });

  it('prunes settled entries after TTL and admits new work at capacity', async () => {
    let now = 1_000;
    const store = new IdempotencyStore({ maxEntries: 10, ttlMs: 100, now: () => now });

    await Promise.all(Array.from({ length: 10 }, (_, index) =>
      store.execute(`key-${index}`, { index }, async () => index)
    ));
    expect(store.size).toBe(10);
    await expect(store.execute('blocked', { index: 11 }, async () => 11))
      .rejects.toMatchObject({ code: 'RATE_LIMITED' });

    now += 101;
    await expect(store.execute('replacement', { index: 12 }, async () => 12)).resolves.toBe(12);
    expect(store.size).toBe(1);
  });

  it('replays one settled failure 100 times without re-running the failed operation', async () => {
    const store = new IdempotencyStore();
    let executions = 0;
    const operation = async (): Promise<never> => {
      executions += 1;
      throw new ConnectorError('RECIPIENT_REJECTED', 'rejected');
    };

    const first = store.execute('failed-key', { creator: 'bad@example.com' }, operation);
    const replays = Array.from({ length: 100 }, () =>
      store.execute('failed-key', { creator: 'bad@example.com' }, operation)
    );
    const outcomes = await Promise.allSettled([first, ...replays]);

    expect(executions).toBe(1);
    expect(outcomes).toHaveLength(101);
    expect(outcomes.every((outcome) =>
      outcome.status === 'rejected' && outcome.reason instanceof ConnectorError && outcome.reason.code === 'RECIPIENT_REJECTED'
    )).toBe(true);
  });

  it('rejects 100 conflicting payloads for one key without invoking conflicting operations', async () => {
    const store = new IdempotencyStore();
    let executions = 0;
    const first = store.execute('conflict-key', { payload: 'original' }, async () => {
      executions += 1;
      await new Promise<void>((resolve) => setImmediate(resolve));
      return 'ok';
    });

    const conflicts = await Promise.allSettled(Array.from({ length: 100 }, (_, index) =>
      store.execute('conflict-key', { payload: `different-${index}` }, async () => {
        executions += 1;
        return 'should-not-run';
      })
    ));

    await expect(first).resolves.toBe('ok');
    expect(executions).toBe(1);
    expect(conflicts.every((outcome) =>
      outcome.status === 'rejected' && outcome.reason instanceof ConnectorError && outcome.reason.code === 'IDEMPOTENCY_CONFLICT'
    )).toBe(true);
  });
});
