import { describe, expect, it } from 'vitest';
import { decodeMessageRef, encodeMessageRef } from '../../src/mail/imap-client.js';
import { ConnectorError } from '../../src/errors.js';

describe('stable IMAP message references', () => {
  it('round-trips mailbox and UID without exposing credentials', () => {
    const ref = encodeMessageRef('INBOX/Creators', 1234);
    expect(ref).not.toContain('INBOX/Creators');
    expect(decodeMessageRef(ref)).toEqual({ mailbox: 'INBOX/Creators', uid: 1234 });
  });

  it('rejects malformed references as MESSAGE_NOT_FOUND', () => {
    expect(() => decodeMessageRef('not-a-valid-ref')).toThrowError(ConnectorError);
    try { decodeMessageRef('not-a-valid-ref'); } catch (error) {
      expect((error as ConnectorError).code).toBe('MESSAGE_NOT_FOUND');
    }
  });
});
