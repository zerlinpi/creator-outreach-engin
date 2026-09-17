import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../src/config.js';
import { SmtpMailClient, buildSmtpTransportOptions } from '../../src/mail/smtp-client.js';

const config: AppConfig = {
  username: 'campx@example.com',
  appPassword: 'app-password',
  fromName: 'CAMPX',
  authToken: '1234567890abcdef',
  port: 3000,
  imap: { host: 'imap.qiye.aliyun.com', port: 993, secure: true },
  smtp: { host: 'smtp.qiye.aliyun.com', port: 465, secure: true }
};

describe('SMTP adapter', () => {
  it('builds implicit-TLS transport options for Alibaba Mail', () => {
    expect(buildSmtpTransportOptions(config)).toEqual({
      host: 'smtp.qiye.aliyun.com',
      port: 465,
      secure: true,
      auth: { user: 'campx@example.com', pass: 'app-password' }
    });
  });

  it('normalizes accepted and rejected recipients from an injected transport', async () => {
    const transport = {
      async sendMail() {
        return { accepted: ['creator@example.com'], rejected: ['bad@example.com'], messageId: '<sent@example.com>' };
      }
    };
    const client = new SmtpMailClient(config, transport);
    const result = await client.send({ to: ['creator@example.com'], subject: 'CAMPX', text: 'Hello' });
    expect(result).toEqual({ accepted: ['creator@example.com'], rejected: ['bad@example.com'], messageId: '<sent@example.com>' });
  });
});
