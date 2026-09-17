import { describe, expect, it } from 'vitest';
import { isAuthorized } from '../../src/auth/bearer.js';

describe('bearer auth', () => {
  it('rejects missing and malformed headers', () => {
    expect(isAuthorized(undefined, 'secret-token-123456')).toBe(false);
    expect(isAuthorized('Basic abc', 'secret-token-123456')).toBe(false);
  });
  it('accepts the exact bearer token only', () => {
    expect(isAuthorized('Bearer secret-token-123456', 'secret-token-123456')).toBe(true);
    expect(isAuthorized('Bearer secret-token-123457', 'secret-token-123456')).toBe(false);
  });
});
