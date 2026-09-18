import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createHttpApp } from '../../src/app.js';
import { IdempotencyStore } from '../../src/mail/idempotency.js';
import type { OutgoingMessage } from '../../src/mail/types.js';

const AUTH_TOKEN = '1234567890abcdef1234567890abcdef';
const servers: Array<{ close(cb?: (err?: Error) => void): void }> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) =>
      new Promise<void>((resolve) => server.close(() => resolve()))
    )
  );
});

function fakeAdapters(sendDelayMs = 0) {
  const sent: OutgoingMessage[] = [];
  const imap = {
    async listMailboxes() {
      return [{ path: 'INBOX', specialUse: '\\Inbox' }];
    },
    async searchEmails() {
      return [];
    },
    async getEmail() {
      throw new Error('not used');
    },
    async getThread() {
      return { messages: [], heuristic: false };
    }
  };
  const smtp = {
    async send(message: OutgoingMessage) {
      sent.push(message);
      if (sendDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, sendDelayMs));
      }
      return {
        accepted: message.to,
        rejected: [],
        messageId: `<limit-${sent.length}@example.com>`
      };
    }
  };
  return { imap, smtp, sent };
}

async function openClient(options: { sendDelayMs?: number; jsonLimit?: string } = {}) {
  const { imap, smtp, sent } = fakeAdapters(options.sendDelayMs ?? 0);
  const app = createHttpApp({
    authToken: AUTH_TOKEN,
    mailboxAddress: 'campx@example.com',
    allowedHosts: ['127.0.0.1'],
    jsonLimit: options.jsonLimit,
    imap: imap as never,
    smtp: smtp as never
  });
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  const endpoint = `http://127.0.0.1:${port}/mcp`;

  const client = new Client(
    { name: 'limit-test', version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' } }
  );
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } }
  });
  await client.connect(transport);
  return { client, transport, endpoint, sent };
}

function parseToolResult(result: Awaited<ReturnType<Client['callTool']>>) {
  const item = result.content[0];
  if (!item || item.type !== 'text') throw new Error('Expected text tool result');
  return JSON.parse(item.text);
}

describe('single-replica limit and capacity verification', () => {
  it('serves 500 concurrent read tool calls through one MCP session', async () => {
    const { client, transport } = await openClient();
    try {
      const results = await Promise.all(
        Array.from({ length: 500 }, () =>
          client.callTool({ name: 'list_mailboxes', arguments: {} })
        )
      );
      expect(results).toHaveLength(500);
      expect(results.every((result) => !result.isError)).toBe(true);
      expect(results.every((result) => parseToolResult(result)[0]?.path === 'INBOX')).toBe(true);
    } finally {
      await transport.terminateSession().catch(() => undefined);
      await client.close();
    }
  });

  it('coalesces 1000 concurrent replays of the same write into one SMTP send', async () => {
    const { client, transport, sent } = await openClient({ sendDelayMs: 10 });
    try {
      const args = {
        to: ['creator@example.com'],
        subject: 'CAMPX concurrency guard',
        text: 'Hello',
        idempotency_key: 'limit-same-key-001'
      };
      const results = await Promise.all(
        Array.from({ length: 1000 }, () =>
          client.callTool({ name: 'send_email', arguments: args })
        )
      );
      expect(results.every((result) => !result.isError)).toBe(true);
      expect(sent).toHaveLength(1);
      const payloads = results.map(parseToolResult);
      expect(payloads.every((payload) => payload.messageId === payloads[0].messageId)).toBe(true);
    } finally {
      await transport.terminateSession().catch(() => undefined);
      await client.close();
    }
  });

  it('fills the 1000-entry idempotency capacity through concurrent MCP writes and fails closed on the next key', async () => {
    const { client, transport, sent } = await openClient({ sendDelayMs: 2 });
    try {
      const results = await Promise.all(
        Array.from({ length: 1000 }, (_, index) =>
          client.callTool({
            name: 'send_email',
            arguments: {
              to: [`creator-${index}@example.com`],
              subject: `CAMPX limit ${index}`,
              text: 'Hello',
              idempotency_key: `limit-unique-${index.toString().padStart(3, '0')}`
            }
          })
        )
      );
      expect(results.every((result) => !result.isError)).toBe(true);
      expect(sent).toHaveLength(1000);
      expect(new Set(sent.map((message) => message.to[0])).size).toBe(1000);

      const overflow = await client.callTool({
        name: 'send_email',
        arguments: {
          to: ['creator-overflow@example.com'],
          subject: 'CAMPX limit overflow',
          text: 'Hello',
          idempotency_key: 'limit-unique-overflow'
        }
      });
      expect(overflow.isError).toBe(true);
      expect(parseToolResult(overflow).error.code).toBe('RATE_LIMITED');
      expect(sent).toHaveLength(1000);
    } finally {
      await transport.terminateSession().catch(() => undefined);
      await client.close();
    }
  });

  it('accepts exactly 1000 protected idempotency entries and fails closed on entry 1001', async () => {
    const store = new IdempotencyStore({ ttlMs: 60_000, maxEntries: 1000 });
    await Promise.all(
      Array.from({ length: 1000 }, (_, index) =>
        store.execute(`capacity-${index}`, { index }, async () => index)
      )
    );
    expect(store.size).toBe(1000);
    await expect(
      store.execute('capacity-1000', { index: 1000 }, async () => 1000)
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(store.size).toBe(1000);
  });

  it('accepts a 25-message batch and rejects a 26-message batch before SMTP', async () => {
    const { client, transport, sent } = await openClient();
    try {
      const valid = Array.from({ length: 25 }, (_, index) => ({
        to: [`batch-${index}@example.com`],
        subject: `CAMPX batch ${index}`,
        text: 'Hello'
      }));
      const validResult = await client.callTool({
        name: 'send_email_batch',
        arguments: {
          max: 25,
          delay_ms: 0,
          dry_run: false,
          idempotency_key: 'limit-batch-25',
          messages: valid
        }
      });
      expect(validResult.isError).not.toBe(true);
      expect(sent).toHaveLength(25);

      const invalid = [...valid, {
        to: ['batch-25@example.com'],
        subject: 'CAMPX batch 25',
        text: 'Hello'
      }];
      const invalidResult = await client.callTool({
        name: 'send_email_batch',
        arguments: {
          max: 25,
          delay_ms: 0,
          dry_run: false,
          idempotency_key: 'limit-batch-26',
          messages: invalid
        }
      });
      expect(invalidResult.isError).toBe(true);
      expect(sent).toHaveLength(25);
    } finally {
      await transport.terminateSession().catch(() => undefined);
      await client.close();
    }
  });

  it('returns HTTP 413 before MCP handling when the JSON request body exceeds the configured cap', async () => {
    const { transport, endpoint } = await openClient({ jsonLimit: '32kb' });
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${AUTH_TOKEN}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ padding: 'x'.repeat(40 * 1024) })
      });
      expect(response.status).toBe(413);
    } finally {
      await transport.terminateSession().catch(() => undefined);
    }
  });
});
