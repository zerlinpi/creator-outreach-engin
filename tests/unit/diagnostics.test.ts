import { describe, expect, it } from 'vitest';
import { runMailDiagnostics } from '../../src/diagnostics.js';

describe('runMailDiagnostics', () => {
  it('passes only when IMAP, SMTP, and a Sent mailbox are available', async () => {
    const imap = {
      async listMailboxes() {
        return [
          { path: 'INBOX', specialUse: '\\Inbox' },
          { path: '已发送', specialUse: '\\Sent' }
        ];
      }
    };
    const smtp = { async verifyConnection() { return true; } };

    await expect(runMailDiagnostics(imap as never, smtp as never)).resolves.toEqual({
      ok: true,
      imap: { ok: true, mailboxCount: 2, sentMailbox: '已发送' },
      smtp: { ok: true },
      warnings: []
    });
  });

  it('reports a missing Sent mailbox without exposing credentials', async () => {
    const imap = {
      async listMailboxes() { return [{ path: 'INBOX', specialUse: '\\Inbox' }]; }
    };
    const smtp = { async verifyConnection() { return true; } };

    const result = await runMailDiagnostics(imap as never, smtp as never);
    expect(result.ok).toBe(false);
    expect(result.imap).toMatchObject({ ok: true, sentMailbox: null });
    expect(result.warnings.join(' ')).toContain('Sent');
    expect(JSON.stringify(result)).not.toContain('password');
  });

  it('returns safe check failures when mail transports cannot authenticate', async () => {
    const imap = { async listMailboxes(): Promise<never> { throw new Error('secret credential failed'); } };
    const smtp = { async verifyConnection(): Promise<never> { throw new Error('smtp secret'); } };

    const result = await runMailDiagnostics(imap as never, smtp as never);
    expect(result.ok).toBe(false);
    expect(result.imap).toEqual({ ok: false, mailboxCount: 0, sentMailbox: null });
    expect(result.smtp).toEqual({ ok: false });
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});
