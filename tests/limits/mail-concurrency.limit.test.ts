import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../src/config.js';
import { ImapMailClient } from '../../src/mail/imap-client.js';
import { SmtpMailClient } from '../../src/mail/smtp-client.js';

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

describe('mail transport concurrency limits', () => {
  it('caps simultaneous IMAP client lifecycles at four', async () => {
    let active = 0;
    let maxActive = 0;
    const client = new ImapMailClient(config);

    (client as unknown as { createClient: () => unknown }).createClient = () => ({
      usable: true,
      async connect() {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => setImmediate(resolve));
      },
      async list() {
        await new Promise<void>((resolve) => setImmediate(resolve));
        return [];
      },
      async logout() {
        active -= 1;
      }
    });

    const results = await Promise.all(Array.from({ length: 20 }, () => client.listMailboxes()));
    expect(results).toHaveLength(20);
    expect(active).toBe(0);
    expect(maxActive).toBeLessThanOrEqual(4);
  });

  it('serializes SMTP transport sends so independent tool calls cannot open a send burst', async () => {
    let active = 0;
    let maxActive = 0;
    let sends = 0;
    const transport = {
      async sendMail(options: { to?: unknown }) {
        sends += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => setImmediate(resolve));
        active -= 1;
        const accepted = Array.isArray(options.to) ? options.to : [];
        return { accepted, rejected: [], messageId: `<sent-${sends}@example.com>` };
      }
    };
    const client = new SmtpMailClient(config, transport as never);

    const results = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      client.send({
        to: [`creator${index}@example.com`],
        subject: `CAMPX ${index}`,
        text: 'Hello'
      })
    ));

    expect(results).toHaveLength(20);
    expect(sends).toBe(20);
    expect(active).toBe(0);
    expect(maxActive).toBe(1);
  });
});
