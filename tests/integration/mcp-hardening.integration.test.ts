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
    async listMailboxes() { return [{ path: 'INBOX', specialUse: '\\Inbox' }]; },
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
  const client = new Client({ name: 'hardening-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: 'Bearer 1234567890abcdef' } }
  });
  await client.connect(transport);
  return { client, transport, sent };
}

function jsonText(result: Awaited<ReturnType<Client['callTool']>>) {
  const item = result.content[0];
  if (!item || item.type !== 'text') throw new Error('Expected text result');
  return JSON.parse(item.text);
}

describe('MCP write hardening', () => {
  it('does not duplicate a send when the same idempotency key is replayed', async () => {
    const { client, transport, sent } = await openClient();
    try {
      const args = {
        to: ['creator@example.com'],
        subject: 'CAMPX partnership',
        text: 'Hello',
        idempotency_key: 'creator-first-contact-001'
      };
      const first = jsonText(await client.callTool({ name: 'send_email', arguments: args }));
      const second = jsonText(await client.callTool({ name: 'send_email', arguments: args }));
      expect(first).toEqual(second);
      expect(sent).toHaveLength(1);
    } finally {
      await transport.terminateSession().catch(() => undefined);
      await client.close();
    }
  });

  it('rejects using one idempotency key for two different sends', async () => {
    const { client, transport, sent } = await openClient();
    try {
      jsonText(await client.callTool({
        name: 'send_email',
        arguments: { to: ['a@example.com'], subject: 'A', text: 'A', idempotency_key: 'same-key-001' }
      }));
      const conflict = await client.callTool({
        name: 'send_email',
        arguments: { to: ['b@example.com'], subject: 'B', text: 'B', idempotency_key: 'same-key-001' }
      });
      expect(conflict.isError).toBe(true);
      expect(jsonText(conflict).error.code).toBe('IDEMPOTENCY_CONFLICT');
      expect(sent).toHaveLength(1);
    } finally {
      await transport.terminateSession().catch(() => undefined);
      await client.close();
    }
  });

  it('preflights a batch with dry_run without invoking SMTP', async () => {
    const { client, transport, sent } = await openClient();
    try {
      const preview = jsonText(await client.callTool({
        name: 'send_email_batch',
        arguments: {
          dry_run: true,
          messages: [
            { to: ['A@Example.COM'], subject: 'CAMPX A', text: 'Private body A' },
            { to: ['b@example.com'], subject: 'CAMPX B', text: 'Private body B' }
          ]
        }
      }));
      expect(preview).toEqual([
        { index: 0, to: ['a@example.com'], cc: [], bcc: [], subject: 'CAMPX A', dryRun: true },
        { index: 1, to: ['b@example.com'], cc: [], bcc: [], subject: 'CAMPX B', dryRun: true }
      ]);
      expect(JSON.stringify(preview)).not.toContain('Private body');
      expect(sent).toHaveLength(0);
    } finally {
      await transport.terminateSession().catch(() => undefined);
      await client.close();
    }
  });

  it('does not consume an idempotency key during dry-run and deduplicates the later real batch', async () => {
    const { client, transport, sent } = await openClient();
    try {
      const messages = [{ to: ['creator@example.com'], subject: 'CAMPX', text: 'Hello' }];
      jsonText(await client.callTool({
        name: 'send_email_batch',
        arguments: { dry_run: true, idempotency_key: 'batch-001', messages }
      }));
      expect(sent).toHaveLength(0);

      const realArgs = { dry_run: false, idempotency_key: 'batch-001', messages, delay_ms: 0 };
      const first = jsonText(await client.callTool({ name: 'send_email_batch', arguments: realArgs }));
      const second = jsonText(await client.callTool({ name: 'send_email_batch', arguments: realArgs }));
      expect(first).toEqual(second);
      expect(sent).toHaveLength(1);
    } finally {
      await transport.terminateSession().catch(() => undefined);
      await client.close();
    }
  });
});
