import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createHttpApp } from '../../src/app.js';
import type { OutgoingMessage } from '../../src/mail/types.js';

const servers: Array<{ close(cb?: (err?: Error) => void): void }> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function openClient() {
  const sent: OutgoingMessage[] = [];
  const imap = {
    async listMailboxes() { return []; },
    async searchEmails() { return []; },
    async getEmail() { throw new Error('not used'); },
    async getThread() { return { messages: [], heuristic: false }; }
  };
  const smtp = {
    async send(message: OutgoingMessage) {
      sent.push(message);
      return { accepted: message.to, rejected: [], messageId: `<sent-${sent.length}@example.com>` };
    }
  };
  const app = createHttpApp({
    authToken: '1234567890abcdef',
    mailboxAddress: 'campx@example.com',
    allowedHosts: ['127.0.0.1'],
    imap: imap as never,
    smtp: smtp as never
  });
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  const client = new Client({ name: 'write-policy-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: 'Bearer 1234567890abcdef' } }
  });
  await client.connect(transport);
  return { client, transport, sent };
}

describe('MCP write policy', () => {
  it('requires idempotency_key for a real single send', async () => {
    const { client, transport, sent } = await openClient();
    try {
      const response = await client.callTool({
        name: 'send_email',
        arguments: { to: ['creator@example.com'], subject: 'CAMPX', text: 'Hello' }
      });
      expect(response.isError).toBe(true);
      expect(sent).toHaveLength(0);
    } finally {
      await transport.terminateSession().catch(() => undefined);
      await client.close();
    }
  });

  it('allows batch dry-run without a key but requires one for the real batch', async () => {
    const { client, transport, sent } = await openClient();
    const messages = [{ to: ['creator@example.com'], subject: 'CAMPX', text: 'Hello' }];
    try {
      const preview = await client.callTool({ name: 'send_email_batch', arguments: { dry_run: true, messages } });
      expect(preview.isError).not.toBe(true);
      expect(sent).toHaveLength(0);

      const real = await client.callTool({ name: 'send_email_batch', arguments: { dry_run: false, messages, delay_ms: 0 } });
      expect(real.isError).toBe(true);
      expect(sent).toHaveLength(0);
    } finally {
      await transport.terminateSession().catch(() => undefined);
      await client.close();
    }
  });

  it('rejects multiple primary recipients on a creator outreach send', async () => {
    const { client, transport, sent } = await openClient();
    try {
      const response = await client.callTool({
        name: 'send_email',
        arguments: {
          to: ['a@example.com', 'b@example.com'],
          subject: 'CAMPX',
          text: 'Hello',
          idempotency_key: 'single-recipient-001'
        }
      });
      expect(response.isError).toBe(true);
      expect(sent).toHaveLength(0);
    } finally {
      await transport.terminateSession().catch(() => undefined);
      await client.close();
    }
  });

  it('rejects oversized outbound bodies before SMTP', async () => {
    const { client, transport, sent } = await openClient();
    try {
      const response = await client.callTool({
        name: 'send_email',
        arguments: {
          to: ['creator@example.com'],
          subject: 'CAMPX',
          text: 'x'.repeat(512_001),
          idempotency_key: 'oversized-body-001'
        }
      });
      expect(response.isError).toBe(true);
      expect(sent).toHaveLength(0);
    } finally {
      await transport.terminateSession().catch(() => undefined);
      await client.close();
    }
  });

  it('rejects CR/LF in outbound subjects before SMTP', async () => {
    const { client, transport, sent } = await openClient();
    try {
      const response = await client.callTool({
        name: 'send_email',
        arguments: {
          to: ['creator@example.com'],
          subject: 'Hello\r\nBcc: hidden@example.com',
          text: 'Hello',
          idempotency_key: 'header-injection-001'
        }
      });
      expect(response.isError).toBe(true);
      expect(sent).toHaveLength(0);
    } finally {
      await transport.terminateSession().catch(() => undefined);
      await client.close();
    }
  });
});
