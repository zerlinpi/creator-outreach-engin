import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReplyMessage } from '../../src/mail/reply.ts';
import type { NormalizedMessage } from '../../src/mail/types.ts';

const parent: NormalizedMessage = {
  connectorId: 'INBOX:42', mailbox: 'INBOX', uid: 42,
  messageId: '<creator-42@example.com>', inReplyTo: '<brand-1@campxusainc.com>',
  references: ['<brand-1@campxusainc.com>'], subject: 'Re: CAMPX x Creator',
  from: { name: 'Creator', address: 'Creator@Example.com' },
  to: [{ address: 'collab@campxusainc.com' }, { address: 'manager@example.com' }],
  cc: [{ address: 'agent@example.com' }], text: 'Interested', attachments: [],
};

test('buildReplyMessage replies to sender and preserves RFC thread headers', () => {
  const reply = buildReplyMessage(parent, { text: 'Thanks — here are the details.' }, 'collab@campxusainc.com');
  assert.deepEqual(reply.to, ['creator@example.com']);
  assert.equal(reply.cc, undefined);
  assert.equal(reply.subject, 'Re: CAMPX x Creator');
  assert.equal(reply.inReplyTo, '<creator-42@example.com>');
  assert.deepEqual(reply.references, ['<brand-1@campxusainc.com>', '<creator-42@example.com>']);
});

test('buildReplyMessage reply-all excludes the mailbox itself and keeps other recipients in cc', () => {
  const reply = buildReplyMessage(parent, { text: 'Thanks', replyAll: true }, 'collab@campxusainc.com');
  assert.deepEqual(reply.to, ['creator@example.com']);
  assert.deepEqual(reply.cc, ['manager@example.com', 'agent@example.com']);
});
