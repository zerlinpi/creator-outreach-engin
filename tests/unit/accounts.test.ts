import { describe, expect, it } from 'vitest';
import { MailAccountRegistry, type MailAccountRuntime } from '../../src/mail/accounts.js';
import { encodeMessageRef } from '../../src/mail/imap-client.js';

function runtime(id: string): MailAccountRuntime {
  return {
    id,
    address: id + '@example.com',
    fromName: id.toUpperCase(),
    imap: {} as never,
    smtp: {} as never
  };
}

describe('MailAccountRegistry', () => {
  it('resolves the configured default and explicit accounts', () => {
    const registry = new MailAccountRegistry([runtime('campx'), runtime('hassky')], 'campx');
    expect(registry.resolve().id).toBe('campx');
    expect(registry.resolve('hassky').id).toBe('hassky');
    expect(registry.size).toBe(2);
  });

  it('infers an account from an account-scoped message reference', () => {
    const registry = new MailAccountRegistry([runtime('campx'), runtime('hassky')], 'campx');
    const ref = encodeMessageRef('INBOX', 42, 99, 'hassky');
    expect(registry.resolveForMessage(ref).id).toBe('hassky');
  });

  it('rejects cross-account reply routing and unknown accounts', () => {
    const registry = new MailAccountRegistry([runtime('campx'), runtime('hassky')], 'campx');
    const ref = encodeMessageRef('INBOX', 42, 99, 'hassky');
    expect(() => registry.resolveForMessage(ref, 'campx')).toThrowError(
      expect.objectContaining({ code: 'ACCOUNT_MISMATCH' })
    );
    expect(() => registry.resolve('missing')).toThrowError(
      expect.objectContaining({ code: 'ACCOUNT_NOT_FOUND' })
    );
  });

  it('routes legacy or opaque references through the requested/default account', () => {
    const registry = new MailAccountRegistry([runtime('campx'), runtime('hassky')], 'campx');
    expect(registry.resolveForMessage('legacy-test-ref').id).toBe('campx');
    expect(registry.resolveForMessage('legacy-test-ref', 'hassky').id).toBe('hassky');
  });
});
