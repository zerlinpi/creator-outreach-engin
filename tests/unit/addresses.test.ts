import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAddress, validateAddressList } from '../../src/mail/addresses.ts';

test('normalizeAddress trims and lowercases the mailbox', () => {
  assert.equal(normalizeAddress('  Creator@Example.COM '), 'creator@example.com');
});

test('validateAddressList de-duplicates normalized addresses', () => {
  assert.deepEqual(validateAddressList(['Creator@example.com', ' creator@EXAMPLE.com ', 'two@example.com']), ['creator@example.com', 'two@example.com']);
});

test('validateAddressList rejects malformed addresses', () => {
  assert.throws(() => validateAddressList(['not-an-email']), /Invalid email address/);
});
