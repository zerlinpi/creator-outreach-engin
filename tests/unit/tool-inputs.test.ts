import test from 'node:test';
import assert from 'node:assert/strict';
import { mapOutgoingInput, validateThreadLookupInput } from '../../src/tools/input.ts';

test('mapOutgoingInput converts reply_to to the transport field without changing recipients', () => {
  assert.deepEqual(mapOutgoingInput({
    to: ['creator@example.com'], subject: 'CAMPX', text: 'Hello', reply_to: 'reply@campxusainc.com',
  }), {
    to: ['creator@example.com'], subject: 'CAMPX', text: 'Hello', replyTo: 'reply@campxusainc.com',
  });
});

test('validateThreadLookupInput requires a message id or participant', () => {
  assert.throws(() => validateThreadLookupInput({ subject: 'CAMPX' }), /message_id or participant is required/);
  assert.deepEqual(validateThreadLookupInput({ participant: 'creator@example.com', subject: 'CAMPX', limit: 30 }), {
    participant: 'creator@example.com', subject: 'CAMPX', limit: 30,
  });
});
