import test from 'node:test';
import assert from 'node:assert/strict';
import { executeBatch, validateBatch } from '../../src/mail/batch.ts';
import { ConnectorError } from '../../src/errors.ts';

const message = (email: string, subject = 'CAMPX Partnership') => ({ to: [email], subject, text: 'Hello' });

test('validateBatch rejects more than the default 10 messages', () => {
  assert.throws(() => validateBatch(Array.from({ length: 11 }, (_, i) => message(`c${i}@example.com`))), /10/);
});

test('validateBatch never permits more than hard maximum 25', () => {
  assert.throws(() => validateBatch(Array.from({ length: 26 }, (_, i) => message(`c${i}@example.com`)), { maxMessages: 25 }), /25/);
});

test('validateBatch rejects duplicate recipient and subject pairs', () => {
  assert.throws(() => validateBatch([message('Creator@example.com'), message('creator@example.com')]), /Duplicate/);
});

test('validateBatch preflights every recipient before any send', async () => {
  let sends = 0;
  await assert.rejects(() => executeBatch([message('valid@example.com'), message('bad-address')], async () => { sends += 1; return { messageId: '<x>', accepted: [], rejected: [] }; }), /Invalid email address/);
  assert.equal(sends, 0);
});

test('executeBatch reports each result and retries one transient failure', async () => {
  const attempts = new Map<string, number>();
  const results = await executeBatch([message('one@example.com'), message('two@example.com')], async (msg) => {
    const email = msg.to[0];
    attempts.set(email, (attempts.get(email) ?? 0) + 1);
    if (email === 'one@example.com' && attempts.get(email) === 1) throw new ConnectorError('TRANSIENT_MAIL_ERROR', 'temporary');
    return { messageId: `<${email}>`, accepted: [email], rejected: [] };
  });
  assert.equal(attempts.get('one@example.com'), 2);
  assert.equal(results.length, 2);
  assert.equal(results.every((r) => r.ok), true);
});
