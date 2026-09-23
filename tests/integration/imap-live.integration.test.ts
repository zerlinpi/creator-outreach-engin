import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../src/config.js';
import { ImapMailClient } from '../../src/mail/imap-client.js';

const enabled = Boolean(
  process.env.TEST_MAIL_USERNAME &&
  process.env.TEST_MAIL_APP_PASSWORD &&
  process.env.TEST_MAIL_LIVE_READ === 'true'
);

function testConfig(): AppConfig {
  return {
    username: process.env.TEST_MAIL_USERNAME!,
    appPassword: process.env.TEST_MAIL_APP_PASSWORD!,
    fromName: 'CAMPX Connector Test',
    authToken: 'integration-test-token-000000000000',
    allowedHosts: ['localhost'],
    jsonLimit: '1mb',
    port: 3000,
    maxMessageBytes: 10 * 1024 * 1024,
    searchSourceBytes: 128 * 1024,
    imap: {
      host: process.env.TEST_MAIL_IMAP_HOST ?? 'imap.qiye.aliyun.com',
      port: Number(process.env.TEST_MAIL_IMAP_PORT ?? '993'),
      secure: true,
      connectionTimeout: 15_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000
    },
    smtp: {
      host: process.env.TEST_MAIL_SMTP_HOST ?? 'smtp.qiye.aliyun.com',
      port: Number(process.env.TEST_MAIL_SMTP_PORT ?? '465'),
      secure: true,
      connectionTimeout: 15_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000
    }
  };
}

describe.skipIf(!enabled)('live IMAP integration (opt-in, non-production test mailbox only)', () => {
  it('logs in over TLS, lists folders, searches Inbox, and can fetch a returned message', async () => {
    const client = new ImapMailClient(testConfig());
    const mailboxes = await client.listMailboxes();

    expect(mailboxes.length).toBeGreaterThan(0);
    expect(mailboxes.some((box) => box.path.toUpperCase() === 'INBOX')).toBe(true);

    const messages = await client.searchEmails({ mailbox: 'INBOX', limit: 1 });
    expect(Array.isArray(messages)).toBe(true);

    if (messages[0]) {
      const fetched = await client.getEmail(messages[0].id);
      expect(fetched.id).toBe(messages[0].id);
      expect(fetched.mailbox).toBe(messages[0].mailbox);
    }
  }, 30_000);
});
