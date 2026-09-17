import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../src/config.js';
import { SmtpMailClient } from '../../src/mail/smtp-client.js';

const enabled = Boolean(
  process.env.TEST_MAIL_USERNAME &&
  process.env.TEST_MAIL_APP_PASSWORD &&
  process.env.TEST_MAIL_RECIPIENT &&
  process.env.TEST_MAIL_LIVE_SEND === 'true'
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

describe.skipIf(!enabled)('live SMTP integration (explicit opt-in, owned recipient only)', () => {
  it('verifies TLS SMTP auth and sends one test message to the owned recipient', async () => {
    const client = new SmtpMailClient(testConfig());
    await expect(client.verifyConnection()).resolves.toBe(true);

    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const result = await client.send({
      to: [process.env.TEST_MAIL_RECIPIENT!],
      subject: `[CAMPX connector test] ${unique}`,
      text: `Connector SMTP verification message. Test id: ${unique}`
    });

    expect(result.accepted.length).toBeGreaterThan(0);
    expect(result.messageId).toBeTruthy();
  }, 30_000);
});
