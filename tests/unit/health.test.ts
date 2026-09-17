import test from 'node:test';
import assert from 'node:assert/strict';
import { healthPayload } from '../../src/health.ts';

test('healthPayload contains no mailbox or secret data', () => {
  assert.deepEqual(healthPayload(), { ok: true, service: 'campx-creator-mail', version: '0.1.0' });
});
