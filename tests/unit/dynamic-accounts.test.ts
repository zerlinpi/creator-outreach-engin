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

  it('deactivates old runtime clients when an account is replaced or removed', () => {
    let imapDisabled = 0;
    let smtpDisabled = 0;
    const old = {
      id: 'campx',
      address: 'old@example.com',
      fromName: 'OLD',
      source: 'ui' as const,
      imap: { disable() { imapDisabled += 1; } } as never,
      smtp: { disable() { smtpDisabled += 1; } } as never
    };
    const replacement = runtime('campx');
    const registry = new MailAccountRegistry([old], 'campx');
    registry.upsert(replacement);
    expect(imapDisabled).toBe(1);
    expect(smtpDisabled).toBe(1);

    let replacementImapDisabled = 0;
    let replacementSmtpDisabled = 0;
    replacement.imap = { disable() { replacementImapDisabled += 1; } } as never;
    replacement.smtp = { disable() { replacementSmtpDisabled += 1; } } as never;
    registry.remove('campx');
    expect(replacementImapDisabled).toBe(1);
    expect(replacementSmtpDisabled).toBe(1);
  });

  it('keeps account-scoped message refs isolated', () => {
    const registry = new MailAccountRegistry([runtime('campx'), runtime('hassky')], 'campx');
    const ref = encodeMessageRef('INBOX', 42, 99, 'hassky');
    expect(registry.resolveForMessage(ref).id).toBe('hassky');
    expect(() => registry.resolveForMessage(ref, 'campx')).toThrowError(expect.objectContaining({ code: 'ACCOUNT_MISMATCH' }));
  });
});
