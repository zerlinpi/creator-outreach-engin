import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../src/config.js';
import { SmtpMailClient } from '../../src/mail/smtp-client.js';

const count = Number(process.env.TEST_MAIL_PACING_COUNT ?? '1');
const delayMs = Number(process.env.TEST_MAIL_PACING_DELAY_MS ?? '500');
const enabled = Boolean(
  process.env.TEST_MAIL_USERNAME &&
  process.env.TEST_MAIL_APP_PASSWORD &&
  process.env.TEST_MAIL_RECIPIENT &&
  process.env.TEST_MAIL_LIVE_PACING === 'true'
);

function validatePacingInput(): void {
  if (!Number.isInteger(count) || count < 1 || count > 25) {
    throw new Error('TEST_MAIL_PACING_COUNT must be an integer between 1 and 25.');
  }
  if (!Number.isInteger(delayMs) || delayMs < 250 || delayMs > 5000) {
    throw new Error('TEST_MAIL_PACING_DELAY_MS must be an integer between 250 and 5000.');
  }
}

function testConfig(): AppConfig {
  return {
    username: process.env.TEST_MAIL_USERNAME!,
    appPassword: process.env.TEST_MAIL_APP_PASSWORD!,
    fromName: 'CAMPX Connector Pacing Test',
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

describe.skipIf(!enabled)('live provider pacing (explicit opt-in, owned recipient only)', () => {
  it('sends a bounded sequential sequence and stops immediately on provider failure', async () => {
    validatePacingInput();

    const client = new SmtpMailClient(testConfig());
    await expect(client.verifyConnection()).resolves.toBe(true);

    const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const results: Array<{ accepted: string[]; rejected: string[]; messageId: string }> = [];

    for (let index = 0; index < count; index += 1) {
      const sequence = index + 1;
      const result = await client.send({
        to: [process.env.TEST_MAIL_RECIPIENT!],
        subject: `[CAMPX pacing test ${sequence}/${count}] ${runId}`,
        text: `Owned-recipient provider pacing test. Run: ${runId}. Message: ${sequence}/${count}.`
      });
      results.push(result);

      if (index < count - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    expect(results).toHaveLength(count);
    expect(results.every((result) => result.accepted.length > 0)).toBe(true);
    expect(results.every((result) => Boolean(result.messageId))).toBe(true);
  }, Math.max(30_000, count * (delayMs + 30_000)));
});
