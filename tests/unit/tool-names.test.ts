import test from 'node:test';
import assert from 'node:assert/strict';
import { MAIL_TOOL_NAMES } from '../../src/tools/names.ts';

test('connector exposes exactly the seven designed mail tools', () => {
  assert.deepEqual(MAIL_TOOL_NAMES, [
    'list_mailboxes', 'search_emails', 'get_email', 'get_thread',
    'send_email', 'reply_email', 'send_email_batch',
  ]);
});
