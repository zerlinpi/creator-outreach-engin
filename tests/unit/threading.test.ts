import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReplyHeaders, normalizeSubject, resolveThread } from '../../src/mail/threading.ts';
import type { NormalizedMessage } from '../../src/mail/types.ts';

function msg(overrides: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    connectorId: 'INBOX:1', mailbox: 'INBOX', uid: 1, subject: 'CAMPX Partnership',
    from: { address: 'creator@example.com' }, to: [{ address: 'collab@campxusainc.com' }],
    cc: [], references: [], text: '', attachments: [], ...overrides,
  };
}

test('normalizeSubject removes repeated reply/forward prefixes', () => {
  assert.equal(normalizeSubject(' Re: FWD:  Re: CAMPX Partnership '), 'CAMPX Partnership');
});

test('buildReplyHeaders preserves the RFC reference chain without duplicates', () => {
  const parent = msg({ messageId: '<m2@example.com>', references: ['<m1@example.com>', '<m1@example.com>'], subject: 'Re: CAMPX Partnership' });
  assert.deepEqual(buildReplyHeaders(parent), {
    subject: 'Re: CAMPX Partnership',
    inReplyTo: '<m2@example.com>',
    references: ['<m1@example.com>', '<m2@example.com>'],
  });
});

test('resolveThread follows RFC message references', () => {
  const first = msg({ uid: 1, connectorId: 'INBOX:1', messageId: '<m1@example.com>', date: '2026-09-01T10:00:00.000Z' });
  const reply = msg({ uid: 2, connectorId: 'INBOX:2', messageId: '<m2@example.com>', inReplyTo: '<m1@example.com>', references: ['<m1@example.com>'], date: '2026-09-02T10:00:00.000Z' });
  const unrelated = msg({ uid: 3, connectorId: 'INBOX:3', messageId: '<x@example.com>', subject: 'Other', date: '2026-09-03T10:00:00.000Z' });
  const result = resolveThread([unrelated, reply, first], reply);
  assert.equal(result.heuristic, false);
  assert.deepEqual(result.messages.map((m) => m.uid), [1, 2]);
});

test('resolveThread marks subject and participant fallback as heuristic', () => {
  const seed = msg({ uid: 10, connectorId: 'INBOX:10', messageId: undefined, date: '2026-09-10T10:00:00.000Z' });
  const earlier = msg({ uid: 9, connectorId: 'INBOX:9', messageId: undefined, date: '2026-09-08T10:00:00.000Z', from: { address: 'collab@campxusainc.com' }, to: [{ address: 'creator@example.com' }] });
  const result = resolveThread([seed, earlier], seed);
  assert.equal(result.heuristic, true);
  assert.deepEqual(result.messages.map((m) => m.uid), [9, 10]);
});
