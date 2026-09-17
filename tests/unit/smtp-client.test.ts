import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../src/config.js';
import { SmtpMailClient, buildSmtpTransportOptions } from '../../src/mail/smtp-client.js';
import { ConnectorError } from '../../src/errors.js';

const config: AppConfig = {
  username: 'campx@example.com',
  appPassword: 'app-password',
  fromName: 'CAMPX',
  authToken: '1234567890abcdef1234567890abcdef',
  jsonLimit: '1mb',
  port: 3000,
  maxMessageBytes: 10 * 1024 * 1024,
  searchSourceBytes: 128 * 1024,
  imap: {
    host: 'imap.qiye.aliyun.com',
    port: 993,
    secure: true,
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000
  },
  smtp: {
    host: 'smtp.qiye.aliyun.com',
    port: 465,
    secure: true,
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000
  }
};

describe('SMTP adapter', () => {
  it('builds implicit-TLS transport options with bounded timeouts for Alibaba Mail', () => {
    expect(buildSmtpTransportOptions(config)).toEqual({
      host: 'smtp.qiye.aliyun.com',
      port: 465,
      secure: true,
      auth: { user: 'campx@example.com', pass: 'app-password' },
      connectionTimeout: 15_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000
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

  it('classifies temporary network transport errors as transient', async () => {
    const transport = {
      async sendMail(): Promise<never> {
        const error = new Error('socket timed out') as Error & { code: string };
        error.code = 'ETIMEDOUT';
        throw error;
      }
    };
    const client = new SmtpMailClient(config, transport);
    try {
      await client.send({ to: ['creator@example.com'], subject: 'CAMPX', text: 'Hello' });
      throw new Error('expected send to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectorError);
      expect((error as ConnectorError).code).toBe('TRANSIENT_MAIL_ERROR');
    }
  });

  it('verifies SMTP authentication without sending a message', async () => {
    let verified = 0;
    const transport = {
      async sendMail() {
        throw new Error('send should not be called');
      },
      async verify() {
        verified += 1;
        return true;
      }
    };
    const client = new SmtpMailClient(config, transport);
    await expect(client.verifyConnection()).resolves.toBe(true);
    expect(verified).toBe(1);
  });
});
