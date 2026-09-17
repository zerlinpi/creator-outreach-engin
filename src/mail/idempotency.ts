import { createHash } from 'node:crypto';
import { ConnectorError } from '../errors.js';

interface Entry<T = unknown> {
  fingerprint: string;
  promise: Promise<T>;
  settled: boolean;
  expiresAt: number;
}

export interface IdempotencyStoreOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 1000;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stableValue(item)])
    );
  }
  return value;
}

function fingerprint(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(stableValue(payload))).digest('hex');
}

export class IdempotencyStore {
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: IdempotencyStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? Date.now;

    if (!Number.isInteger(this.ttlMs) || this.ttlMs < 1_000 || this.ttlMs > 24 * 60 * 60 * 1000) {
      throw new ConnectorError('RATE_LIMITED', 'Idempotency TTL must be between 1000 ms and 24 hours.');
    }
    if (!Number.isInteger(this.maxEntries) || this.maxEntries < 1 || this.maxEntries > 10_000) {
      throw new ConnectorError('RATE_LIMITED', 'Idempotency capacity must be between 1 and 10000 entries.');
    }
  }

  get size(): number {
    this.pruneExpired();
    return this.entries.size;
  }

  async execute<T>(key: string, payload: unknown, operation: () => Promise<T>): Promise<T> {
    this.pruneExpired();
    const digest = fingerprint(payload);
    const existing = this.entries.get(key);

    if (existing) {
      if (existing.fingerprint !== digest) {
        throw new ConnectorError('IDEMPOTENCY_CONFLICT', 'The idempotency key was already used for a different request.');
      }
      return existing.promise as Promise<T>;
    }

    this.makeRoom();

    const entry: Entry<T> = {
      fingerprint: digest,
      settled: false,
      expiresAt: Number.POSITIVE_INFINITY,
      promise: Promise.resolve(undefined as T)
    };

    entry.promise = Promise.resolve()
      .then(operation)
      .finally(() => {
        entry.settled = true;
        entry.expiresAt = this.now() + this.ttlMs;
      });

    this.entries.set(key, entry);
    return entry.promise;
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.settled && entry.expiresAt <= now) this.entries.delete(key);
    }
  }

  private makeRoom(): void {
    while (this.entries.size >= this.maxEntries) {
      let evicted = false;
      for (const [key, entry] of this.entries) {
        if (entry.settled) {
          this.entries.delete(key);
          evicted = true;
          break;
        }
      }
      if (!evicted) {
        throw new ConnectorError('RATE_LIMITED', 'Idempotency capacity is temporarily full with in-flight requests.');
      }
    }
  }
}
