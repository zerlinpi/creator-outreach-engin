import { describe, expect, it } from 'vitest';
import { pickMailboxBySpecialUse } from '../../src/mail/mailboxes.js';

describe('mailbox selection', () => {
  it('prefers IMAP special-use metadata over localized folder names', () => {
    const path = pickMailboxBySpecialUse([
      { path: 'INBOX', specialUse: '\\Inbox' },
      { path: '已发送', specialUse: '\\Sent' },
      { path: 'Archive', specialUse: '\\Archive' }
    ], '\\Sent', ['Sent', 'Sent Messages']);
    expect(path).toBe('已发送');
  });

  it('falls back to common folder names when special-use metadata is absent', () => {
    const path = pickMailboxBySpecialUse([
      { path: 'INBOX', specialUse: null },
      { path: 'Sent Messages', specialUse: null }
    ], '\\Sent', ['Sent', 'Sent Messages']);
    expect(path).toBe('Sent Messages');
  });

  it('returns null when no safe match exists', () => {
    expect(pickMailboxBySpecialUse([{ path: 'INBOX', specialUse: null }], '\\Sent', ['Sent'])).toBeNull();
  });
});
