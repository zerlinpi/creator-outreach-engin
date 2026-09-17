import { describe, expect, it } from 'vitest';
import { buildReplyMessage } from '../../src/mail/reply.js';
import type { NormalizedMessage } from '../../src/mail/types.js';

const parent: NormalizedMessage = { id: 'INBOX:1', mailbox: 'INBOX', uid: 1, from: ['creator@example.com'], to: ['campx@example.com'], cc: ['manager@example.com'], subject: 'CAMPX collaboration', date: new Date(), text: 'hello', html: null, messageId: '<parent@example.com>', inReplyTo: null, references: ['<root@example.com>'], attachments: [] };

describe('buildReplyMessage', () => {
  it('replies to sender and keeps RFC thread headers', () => {
    const result = buildReplyMessage(parent, { text: 'Thanks', replyAll: false }, 'campx@example.com');
    expect(result.to).toEqual(['creator@example.com']);
    expect(result.subject).toBe('Re: CAMPX collaboration');
    expect(result.inReplyTo).toBe('<parent@example.com>');
    expect(result.references).toEqual(['<root@example.com>', '<parent@example.com>']);
  });

  it('reply-all excludes the mailbox itself and keeps other recipients', () => {
    const result = buildReplyMessage(parent, { text: 'Thanks', replyAll: true }, 'campx@example.com');
    expect(result.to).toContain('creator@example.com');
    expect(result.cc).toContain('manager@example.com');
    expect(result.to).not.toContain('campx@example.com');
  });

  it('continues a follow-up when the selected parent message was sent by CAMPX', () => {
    const sent: NormalizedMessage = {
      ...parent,
      id: 'sent:2',
      mailbox: 'Sent Messages',
      uid: 2,
      from: ['campx@example.com'],
      to: ['creator@example.com'],
      cc: [],
      messageId: '<sent-2@example.com>'
    };
    const result = buildReplyMessage(sent, { text: 'Following up' }, 'campx@example.com');
    expect(result.to).toEqual(['creator@example.com']);
    expect(result.inReplyTo).toBe('<sent-2@example.com>');
  });
});
