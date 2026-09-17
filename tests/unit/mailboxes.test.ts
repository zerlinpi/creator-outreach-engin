import { describe, expect, it } from 'vitest';
import { pickMailboxBySpecialUse, resolveMailboxAlias } from '../../src/mail/mailboxes.js';

const boxes = [
  { path: 'INBOX', specialUse: '\\Inbox' },
  { path: '已发送', specialUse: '\\Sent' },
  { path: 'Archive', specialUse: '\\Archive' }
];

describe('mailbox selection', () => {
  it('prefers IMAP special-use metadata over localized folder names', () => {
    expect(pickMailboxBySpecialUse(boxes, '\\Sent', ['Sent', 'Sent Messages'])).toBe('已发送');
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

  it('resolves the portable SENT alias to the provider-specific sent folder', () => {
    expect(resolveMailboxAlias('SENT', boxes)).toBe('已发送');
    expect(resolveMailboxAlias('\\Sent', boxes)).toBe('已发送');
  });

  it('preserves exact custom mailbox paths', () => {
    expect(resolveMailboxAlias('Archive', boxes)).toBe('Archive');
  });
});
