import { describe, expect, it } from 'vitest';
import { classifyOutreachMessages, loadOutreachOverview } from '../../src/outreach-overview.js';
import { MailAccountRegistry, type MailAccountRuntime } from '../../src/mail/accounts.js';
import type { NormalizedMessage } from '../../src/mail/types.js';

const now = new Date('2026-10-09T08:00:00Z');
function mail(id: string, sender: string, recipient: string, date: string, extra: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    id, account: 'brand', mailbox: 'INBOX', uid: 1,
    from: [sender], to: [recipient], cc: [], subject: 'Creator partnership',
    date: new Date(date), text: 'Sample body', html: null, messageId: '<' + id + '@test>',
    inReplyTo: null, references: [], attachments: [], unread: true, ...extra
  };
}
const own = 'team@brand.example';
const creator = 'creator@example.com';
const outgoing = (id: string, date: string, extra: Partial<NormalizedMessage> = {}) =>
  mail(id, own, creator, date, { mailbox: 'Sent', unread: false, ...extra });
const incoming = (id: string, date: string, extra: Partial<NormalizedMessage> = {}) =>
  mail(id, creator, own, date, extra);

describe('Outreach overview classification', () => {
  it('distinguishes new outreach, overdue unanswered and follow-up', () => {
    const fresh = classifyOutreachMessages('brand', own, [], [outgoing('s1', '2026-10-09T07:00:00Z')], now)[0];
    expect(fresh).toMatchObject({ stage: 'new_contact', needsAttention: false, sentCount: 1 });
    const stale = classifyOutreachMessages('brand', own, [], [outgoing('s1', '2026-10-05T08:00:00Z')], now)[0];
    expect(stale).toMatchObject({ stage: 'awaiting_reply', needsAttention: true });
    const followed = classifyOutreachMessages('brand', own, [], [
      outgoing('s1', '2026-10-01T00:00:00Z'),
      outgoing('s2', '2026-10-07T00:00:00Z')
    ], now)[0];
    expect(followed).toMatchObject({ stage: 'followed_up', sentCount: 2, needsAttention: false });
  });

  it('recognizes confirmed replies by RFC headers, not just matching subject', () => {
    const sent = outgoing('s1', '2026-10-08T00:00:00Z');
    const reply = incoming('r1', '2026-10-09T06:00:00Z', { inReplyTo: '<s1@test>' });
    expect(classifyOutreachMessages('brand', own, [reply], [sent], now)[0])
      .toMatchObject({ stage: 'creator_replied', unread: true, receivedCount: 1, needsAttention: false });
    expect(classifyOutreachMessages('brand', own, [incoming('r2', '2026-10-09T06:00:00Z')], [sent], now)[0].stage)
      .toBe('possible_reply');
  });

  it('recognizes latest sender-side response and does not mix different accounts or correspondents', () => {
    const reply = incoming('r1', '2026-10-08T00:00:00Z', { inReplyTo: '<s1@test>' });
    const history = [outgoing('s1', '2026-10-01T00:00:00Z'), outgoing('s2', '2026-10-09T07:00:00Z')];
    expect(classifyOutreachMessages('brand', own, [reply], history, now)[0].stage).toBe('we_replied');
    const unmatched = incoming('other', '2026-10-09T00:00:00Z', { from: ['other@example.com'] });
    const conversations = classifyOutreachMessages('brand', own, [reply, unmatched], history, now);
    expect(conversations).toHaveLength(2);
    expect(conversations.find((t) => t.participant === 'other@example.com')?.stage).toBe('inbound');
  });

  it('reports folder failure and suppresses misleading inferred status for that account', async () => {
    const runtime = (id: string, fails: boolean): MailAccountRuntime => ({
      id, address: own, fromName: id,
      imap: { searchEmails: async ({ mailbox }: { mailbox: string }) => {
        if (fails && mailbox === 'SENT') throw new Error('Missing Sent');
        return mailbox === 'SENT' ? [outgoing('s1', '2026-10-01T00:00:00Z')] : [];
      } },
      smtp: {}
    }) as unknown as MailAccountRuntime;
    const registry = new MailAccountRegistry([runtime('broken', true), runtime('healthy', false)]);
    const result = await loadOutreachOverview(registry, 'all', 25, now);
    expect(result.conversations).toHaveLength(1);
    expect(result.conversations[0].account).toBe('healthy');
    expect(result.errors).toEqual([{ account: 'broken', folder: 'SENT', error: expect.any(String) }]);
    expect(result.limitedHistory).toBe(true);
    await expect(loadOutreachOverview(registry, 'missing', 25, now)).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
  });
});
