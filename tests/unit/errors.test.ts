import test from 'node:test';
import assert from 'node:assert/strict';
import { ConnectorError, toSafeError } from '../../src/errors.ts';

test('toSafeError returns only safe connector error fields', () => {
  const err = new ConnectorError('AUTH_FAILED', 'Mailbox authentication failed', { internal: 'password=secret' });
  const safe = toSafeError(err);
  assert.deepEqual(safe, { code: 'AUTH_FAILED', message: 'Mailbox authentication failed' });
  assert.equal(JSON.stringify(safe).includes('secret'), false);
});

test('toSafeError hides unknown stack traces and internal messages', () => {
  const err = new Error('smtp password=supersecret');
  err.stack = 'STACK supersecret';
  const safe = toSafeError(err);
  assert.deepEqual(safe, { code: 'INTERNAL_ERROR', message: 'Internal connector error' });
});
