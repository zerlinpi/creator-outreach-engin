import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createHttpApp } from '../../src/app.js';
import type { OutgoingMessage } from '../../src/mail/types.js';

const AUTH_TOKEN = '1234567890abcdef1234567890abcdef';
const servers: Array<{ close(cb?: (err?: Error) => void): void }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolve) => server.close(() => resolve()))
  ));
});

async function startApp(options: { jsonLimit?: string; searchEmails?: () => Promise<never[]> } = {}) {
  let writes = 0;
  const imap = {
    async listMailboxes() { return [{ path: 'INBOX', specialUse: '\\Inbox' }]; },
    async searchEmails() { return options.searchEmails ? options.searchEmails() : []; },
    async getEmail() { throw new Error('not used'); },
    async getThread() { return { messages: [], heuristic: false }; }
  };
  const smtp = {
    async send(message: OutgoingMessage) {
      writes += 1;
      return { accepted: message.to, rejected: [], messageId: '<unexpected@example.com>' };
    }
  };
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
  return { baseUrl: `http://127.0.0.1:${port}`, writes };
}

async function openClient(baseUrl: string) {
  const client = new Client({ name: 'limit-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } }
  });
  await client.connect(transport);
  return { client, transport };
}

function isJsonTextResult(value: Awaited<ReturnType<Client['callTool']>>): boolean {
  const item = value.content[0];
  if (!item || item.type !== 'text') return false;
  try {
    JSON.parse(item.text);
    return true;
  } catch {
    return false;
  }
}

describe('MCP HTTP capacity boundaries', () => {
  it('serves 100 concurrent read-only tool calls without invoking the write path', async () => {
    let searches = 0;
    const { baseUrl } = await startApp({
      searchEmails: async () => {
        searches += 1;
        await new Promise<void>((resolve) => setImmediate(resolve));
        return [];
      }
    });
    const { client, transport } = await openClient(baseUrl);

    try {
      const results = await Promise.all(Array.from({ length: 100 }, () =>
        client.callTool({ name: 'search_emails', arguments: { limit: 1 } })
      ));
      expect(results).toHaveLength(100);
      expect(results.every((value) => value.isError !== true && isJsonTextResult(value))).toBe(true);
      expect(searches).toBe(100);
    } finally {
      await transport.terminateSession().catch(() => undefined);
      await client.close();
    }
  });

  it.each([
    ['32kb', 40 * 1024],
    ['2mb', 2 * 1024 * 1024 + 64 * 1024]
  ])('rejects an oversized JSON body when the configured MCP limit is %s', async (jsonLimit, payloadBytes) => {
    const { baseUrl } = await startApp({ jsonLimit });
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      padding: 'x'.repeat(payloadBytes)
    });

    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body
    });

    expect(response.status).toBe(413);
  });

  it('keeps a small authorized MCP request functional at the minimum 32kb limit', async () => {
    const { baseUrl } = await startApp({ jsonLimit: '32kb' });
    const { client, transport } = await openClient(baseUrl);
    try {
      const response = await client.callTool({ name: 'search_emails', arguments: { limit: 1 } });
      expect(response.isError).not.toBe(true);
      expect(isJsonTextResult(response)).toBe(true);
    } finally {
      await transport.terminateSession().catch(() => undefined);
      await client.close();
    }
  });
});
