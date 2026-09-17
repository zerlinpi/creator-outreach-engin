import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeParsedEmail } from '../../src/mail/parser-normalize.ts';

test('normalizeParsedEmail maps identifiers, addresses and attachment metadata', () => {
  const result = normalizeParsedEmail({
    subject: 'CAMPX x Creator', messageId: '<m1@example.com>', inReplyTo: '<p@example.com>',
    references: '<a@example.com> <p@example.com>', date: '2026-09-17T00:00:00.000Z',
    from: { name: 'Creator', address: 'creator@example.com' },
    to: [{ address: 'collab@campxusainc.com' }], cc: [], text: 'Hello', html: '<p>Hello</p>',
    attachments: [{ filename: 'rate-card.pdf', mimeType: 'application/pdf', contentId: 'cid1', content: new Uint8Array([1,2,3]) }],
  }, { mailbox: 'INBOX', uid: 7, unread: true });
  assert.equal(result.connectorId.startsWith('mref_'), true);
  assert.deepEqual(result.references, ['<a@example.com>', '<p@example.com>']);
  assert.deepEqual(result.from, { name: 'Creator', address: 'creator@example.com' });
  assert.deepEqual(result.attachments, [{ filename: 'rate-card.pdf', contentType: 'application/pdf', size: 3, contentId: 'cid1' }]);
  assert.equal(result.unread, true);
});
