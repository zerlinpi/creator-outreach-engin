import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeMessageRef, encodeMessageRef } from '../../src/mail/message-ref.ts';

test('message refs round-trip mailbox and uid', () => {
  const ref = encodeMessageRef('Sent Items', 42);
  assert.match(ref, /^mref_/);
  assert.deepEqual(decodeMessageRef(ref), { mailbox: 'Sent Items', uid: 42 });
});

test('decodeMessageRef rejects malformed refs', () => {
  assert.throws(() => decodeMessageRef('bad'), /Invalid message reference/);
});
