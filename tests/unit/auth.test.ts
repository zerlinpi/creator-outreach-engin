import test from 'node:test';
import assert from 'node:assert/strict';
import { isAuthorizedBearer } from '../../src/auth/bearer.ts';

test('isAuthorizedBearer rejects missing and malformed authorization headers', () => {
  assert.equal(isAuthorizedBearer(undefined, 'secret'), false);
  assert.equal(isAuthorizedBearer('Basic abc', 'secret'), false);
  assert.equal(isAuthorizedBearer('Bearer', 'secret'), false);
});

test('isAuthorizedBearer accepts the exact bearer token only', () => {
  assert.equal(isAuthorizedBearer('Bearer connector-secret', 'connector-secret'), true);
  assert.equal(isAuthorizedBearer('Bearer connector-secrex', 'connector-secret'), false);
});
