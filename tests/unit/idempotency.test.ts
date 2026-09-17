import { describe, expect, it } from 'vitest';
import { ConnectorError } from '../../src/errors.js';
import { IdempotencyStore } from '../../src/mail/idempotency.js';

describe('IdempotencyStore', () => {
  it('coalesces concurrent requests with the same key and payload', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const store = new IdempotencyStore({ ttlMs: 60_000, maxEntries: 100 });

    const operation = async () => {
      calls += 1;
      await gate;
      return { messageId: '<one@example.com>' };
    };

    const first = store.execute('send:creator-1', { to: ['creator@example.com'], subject: 'Hello' }, operation);
    const second = store.execute('send:creator-1', { subject: 'Hello', to: ['creator@example.com'] }, operation);
    expect(calls).toBe(1);

    release();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { messageId: '<one@example.com>' },
      { messageId: '<one@example.com>' }
    ]);
    expect(calls).toBe(1);
  });

  it('replays the cached result without executing the operation again', async () => {
    let calls = 0;
    const store = new IdempotencyStore({ ttlMs: 60_000, maxEntries: 100 });
    const operation = async () => ({ count: ++calls });

    await expect(store.execute('reply:1', { text: 'Thanks' }, operation)).resolves.toEqual({ count: 1 });
    await expect(store.execute('reply:1', { text: 'Thanks' }, operation)).resolves.toEqual({ count: 1 });
    expect(calls).toBe(1);
  });

  it('rejects reusing the same key for a different payload', async () => {
    const store = new IdempotencyStore({ ttlMs: 60_000, maxEntries: 100 });
    await store.execute('send:1', { subject: 'A' }, async () => 'sent');

    await expect(store.execute('send:1', { subject: 'B' }, async () => 'sent-again')).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT'
    } satisfies Partial<ConnectorError>);
  });

  it('caches failures for the TTL to avoid an immediate ambiguous resend', async () => {
    let calls = 0;
    const store = new IdempotencyStore({ ttlMs: 60_000, maxEntries: 100 });
    const operation = async () => {
      calls += 1;
      throw new ConnectorError('TRANSIENT_MAIL_ERROR', 'Connection dropped after send attempt.');
    };

    await expect(store.execute('send:ambiguous', { subject: 'A' }, operation)).rejects.toMatchObject({ code: 'TRANSIENT_MAIL_ERROR' });
    await expect(store.execute('send:ambiguous', { subject: 'A' }, operation)).rejects.toMatchObject({ code: 'TRANSIENT_MAIL_ERROR' });
    expect(calls).toBe(1);
  });

  it('allows a fresh execution after TTL expiry', async () => {
    let now = 1_000;
    let calls = 0;
    const store = new IdempotencyStore({ ttlMs: 500, maxEntries: 100, now: () => now });

    await store.execute('send:ttl', { subject: 'A' }, async () => ++calls);
    now += 501;
    await expect(store.execute('send:ttl', { subject: 'A' }, async () => ++calls)).resolves.toBe(2);
  });

  it('fails closed at capacity instead of evicting an unexpired idempotency record', async () => {
    let calls = 0;
    const store = new IdempotencyStore({ ttlMs: 60_000, maxEntries: 2 });

    await expect(store.execute('k1', { n: 1 }, async () => ++calls)).resolves.toBe(1);
    await expect(store.execute('k2', { n: 2 }, async () => ++calls)).resolves.toBe(2);
    await expect(store.execute('k3', { n: 3 }, async () => ++calls)).rejects.toMatchObject({ code: 'RATE_LIMITED' });

    await expect(store.execute('k1', { n: 1 }, async () => ++calls)).resolves.toBe(1);
    expect(calls).toBe(2);
    expect(store.size).toBe(2);
  });

  it('accepts a new key after TTL expiry frees capacity', async () => {
    let now = 1_000;
    let calls = 0;
    const store = new IdempotencyStore({ ttlMs: 500, maxEntries: 2, now: () => now });

    await store.execute('k1', { n: 1 }, async () => ++calls);
    await store.execute('k2', { n: 2 }, async () => ++calls);
    now += 501;

    await expect(store.execute('k3', { n: 3 }, async () => ++calls)).resolves.toBe(3);
    expect(store.size).toBe(1);
  });
});
