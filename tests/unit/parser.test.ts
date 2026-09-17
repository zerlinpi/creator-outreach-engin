import { describe, expect, it } from 'vitest';
import { parseMessage } from '../../src/mail/parser.js';

describe('parseMessage', () => {
  it('normalizes multipart mail, encoded subject, reply routing, RFC thread headers, and attachment metadata', async () => {
    const raw = [
      'From: Creator <Creator@Example.COM>',
      'Reply-To: Partnerships <Partnerships@Agency.Example>',
      'To: CAMPX <campx@example.com>',
      'Subject: =?UTF-8?B?Q0FNUFgg4pyF?=',
      'Message-ID: <reply-2@example.com>',
      'In-Reply-To: <root@example.com>',
      'References: <root@example.com> <reply-1@example.com>',
      'Date: Thu, 17 Sep 2026 12:00:00 +0000',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="outer"',
      '',
      '--outer',
      'Content-Type: multipart/alternative; boundary="inner"',
      '',
      '--inner',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Interested in the CAMPX partnership.',
      '--inner',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>Interested in the <b>CAMPX</b> partnership.</p>',
      '--inner--',
      '--outer',
      'Content-Type: text/plain; name="rate-card.txt"',
      'Content-Disposition: attachment; filename="rate-card.txt"',
      'Content-Transfer-Encoding: base64',
      '',
      'UmF0ZTogJDUwMA==',
      '--outer--',
      ''
    ].join('\r\n');

    const message = await parseMessage(raw, { id: 'ref-1', mailbox: 'INBOX', uid: 42, unread: true });

    expect(message.from).toEqual(['creator@example.com']);
    expect(message.replyTo).toEqual(['partnerships@agency.example']);
    expect(message.to).toEqual(['campx@example.com']);
    expect(message.subject).toBe('CAMPX ✅');
    expect(message.messageId).toBe('<reply-2@example.com>');
    expect(message.inReplyTo).toBe('<root@example.com>');
    expect(message.references).toEqual(['<root@example.com>', '<reply-1@example.com>']);
    expect(message.text).toContain('Interested in the CAMPX partnership.');
    expect(message.html).toContain('<b>CAMPX</b>');
    expect(message.attachments).toEqual([
      expect.objectContaining({ filename: 'rate-card.txt', contentType: 'text/plain', size: 10 })
    ]);
    expect(message.unread).toBe(true);
  });

  it('preserves recipients across repeated To and Cc headers', async () => {
    const raw = [
      'From: Creator <creator@example.com>',
      'To: CAMPX <campx@example.com>',
      'To: Marketing <marketing@campx.example>',
      'Cc: Manager <manager@agency.example>',
      'Cc: Assistant <assistant@agency.example>',
      'Subject: Multiple recipients',
      'Message-ID: <multi@example.com>',
      '',
      'Hello everyone.'
    ].join('\r\n');

    const message = await parseMessage(raw, { id: 'ref-2', mailbox: 'INBOX', uid: 43 });
    expect(message.to).toEqual(expect.arrayContaining(['campx@example.com', 'marketing@campx.example']));
    expect(message.to).toHaveLength(2);
    expect(message.cc).toEqual(expect.arrayContaining(['manager@agency.example', 'assistant@agency.example']));
    expect(message.cc).toHaveLength(2);
  });
});
