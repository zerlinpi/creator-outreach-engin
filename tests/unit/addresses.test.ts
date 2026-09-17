import { describe, expect, it } from 'vitest';
import { normalizeAddress, validateAddressList } from '../../src/mail/addresses.js';

describe('mail addresses', () => {
  it('normalizes whitespace and case', () => expect(normalizeAddress('  Name@Example.COM ')).toBe('name@example.com'));
  it('deduplicates validated addresses', () => expect(validateAddressList(['A@example.com', ' a@example.com ', 'b@example.com'])).toEqual(['a@example.com', 'b@example.com']));
  it('rejects invalid addresses', () => expect(() => validateAddressList(['not-an-email'])).toThrow());
});
