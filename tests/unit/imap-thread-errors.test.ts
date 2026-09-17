import { describe, expect, it } from 'vitest';
import { ImapMailClient, type SearchCriteria } from '../../src/mail/imap-client.js';
import { ConnectorError } from '../../src/errors.js';
import type { AppConfig } from '../../src/config.js';
import type { NormalizedMessage } from '../../src/mail/types.js';

const config: AppConfig = {
  username: 'campx@example.com',
  appPassword: 'app-password',
  fromName: 'CAMPX',
  authToken: '1234567890abcdef',
  jsonLimit: '1mb',
  port: 3000,
  imap: { host: 'imap.qiye.aliyun.com', port: 993, secure: true },
  smtp: { host: 'smtp.qiye.aliyun.com', port: 465, secure: true }
};

const anchor: NormalizedMessage = {
  id: 'anchor',
  mailbox: 'INBOX',
  uid: 1,
  from: ['creator@example.com'],
  to: ['campx@example.com'],
  cc: [],
  subject: 'CAMPX collaboration',
  date: new Date('2026-09-17T10:00:00Z'),
  text: 'hello',
  html: null,
  messageId: '<anchor@example.com>',
  inReplyTo: null,
  references: [],
  attachments: [],
  unread: true
};

class FailingThreadClient extends ImapMailClient {
  constructor() { super(config); }

  override async listMailboxes() {
    return [
      { path: 'INBOX', specialUse: '\\Inbox' },
      { path: 'Sent Messages', specialUse: '\\Sent' }
    ];
  }

  override async getEmail() {
    return anchor;
  }

  override async searchEmails(_criteria: SearchCriteria): Promise<NormalizedMessage[]> {
    throw new ConnectorError('AUTH_FAILED', 'Mailbox authentication failed.');
  }
}

describe('getThread error handling', () => {
  it('does not convert participant-search authentication failures into THREAD_NOT_FOUND', async () => {
    const client = new FailingThreadClient();
    await expect(client.getThread({ participant: 'creator@example.com' })).rejects.toMatchObject({ code: 'AUTH_FAILED' });
  });

  it('does not silently return an incomplete thread when cross-folder search fails', async () => {
    const client = new FailingThreadClient();
    await expect(client.getThread({ messageRef: 'anchor' })).rejects.toMatchObject({ code: 'AUTH_FAILED' });
  });
});
