import { describe, expect, it } from 'vitest';
import { MailAccountRegistry, type MailAccountRuntime } from '../../src/mail/accounts.js';
import { encodeMessageRef } from '../../src/mail/imap-client.js';

function runtime(id: string): MailAccountRuntime {
  return { id, address: id + '@example.com', fromName: id.toUpperCase(), source: 'ui', imap: {} as never, smtp: {} as never };
}

describe('dynamic MailAccountRegistry', () => {
  it('supports zero-to-many runtime mailboxes and changing the default', () => {
    const registry = new MailAccountRegistry();
    expect(registry.size).toBe(0);
    expect(() => registry.resolve()).toThrowError(expect.objectContaining({ code: 'ACCOUNT_NOT_FOUND' }));

    for (let index = 0; index < 12; index += 1) registry.upsert(runtime('brand' + index));
    expect(registry.size).toBe(12);
    registry.setDefault('brand9');
    expect(registry.defaultAccountId).toBe('brand9');
    expect(() => registry.resolve()).toThrowError(expect.objectContaining({ code: 'ACCOUNT_REQUIRED' }));
    expect(registry.resolve('brand9').id).toBe('brand9');
    registry.remove('brand9');
    expect(registry.size).toBe(11);
    expect(registry.defaultAccountId).not.toBe('brand9');
  });

  it('keeps account-scoped message refs isolated', () => {
    const registry = new MailAccountRegistry([runtime('campx'), runtime('hassky')], 'campx');
    const ref = encodeMessageRef('INBOX', 42, 99, 'hassky');
    expect(registry.resolveForMessage(ref).id).toBe('hassky');
    expect(() => registry.resolveForMessage(ref, 'campx')).toThrowError(expect.objectContaining({ code: 'ACCOUNT_MISMATCH' }));
  });
});
