import type { Request, Response } from 'express';

interface FailureState {
  count: number;
  windowStartedAt: number;
  blockedUntil: number;
}

export class FailureRateLimiter {
  private readonly states = new Map<string, FailureState>();

  constructor(
    private readonly maxFailures: number,
    private readonly windowMs: number,
    private readonly blockMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 5000
  ) {
    if (maxFailures < 1 || windowMs < 1 || blockMs < 1) throw new Error('Invalid failure limiter policy.');
  }

  private prune(current = this.now()): void {
    for (const [key, state] of this.states) {
      if (state.blockedUntil <= current && current - state.windowStartedAt >= this.windowMs) this.states.delete(key);
    }
  }

  check(key: string): { allowed: boolean; retryAfterSeconds?: number } {
    const current = this.now();
    this.prune(current);
    const state = this.states.get(key);
    if (!state) return { allowed: true };
    if (state.blockedUntil > current) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((state.blockedUntil - current) / 1000)) };
    }
    if (current - state.windowStartedAt >= this.windowMs) this.states.delete(key);
    return { allowed: true };
  }

  failure(key: string): void {
    const current = this.now();
    this.prune(current);
    if (!this.states.has(key) && this.states.size >= this.maxKeys) {
      const oldest = this.states.keys().next().value as string | undefined;
      if (oldest) this.states.delete(oldest);
    }
    const existing = this.states.get(key);
    const state = !existing || current - existing.windowStartedAt >= this.windowMs
      ? { count: 0, windowStartedAt: current, blockedUntil: 0 }
      : existing;

    state.count += 1;
    if (state.count >= this.maxFailures) state.blockedUntil = current + this.blockMs;
    this.states.set(key, state);
  }

  success(key: string): void {
    this.states.delete(key);
  }
}

export function requestClientKey(req: Request): string {
  return req.socket.remoteAddress ?? 'unknown';
}

export function applySensitiveHeaders(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'");
}

export function isSameOriginMutation(req: Request): boolean {
  const origin = req.header('origin');
  if (!origin) return true;
  try {
    const originUrl = new URL(origin);
    return originUrl.host.toLowerCase() === (req.header('host') ?? '').toLowerCase();
  } catch {
    return false;
  }
}
