import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createHttpApp } from '../../src/app.js';

const servers: Array<{ close(cb?: (err?: Error) => void): void }> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function fakeAdapters() {
  const imap = {
    async listMailboxes() { return [{ path: 'INBOX', specialUse: '\\Inbox' }]; },
    async searchEmails() { return []; },
    async getEmail() { throw new Error('not needed'); },
    async getThread() { return { messages: [], heuristic: false }; }
  };
  const smtp = {
    async send(message: { to: string[] }) { return { accepted: message.to, rejected: [], messageId: '<test@example.com>' }; }
  };
  return { imap, smtp };
}

describe('remote MCP HTTP surface', () => {
  it('rejects unauthenticated MCP requests and exposes exactly seven mail tools to an authenticated client', async () => {
    const { imap, smtp } = fakeAdapters();
    const app = createHttpApp({ authToken: '1234567890abcdef', mailboxAddress: 'campx@example.com', imap: imap as never, smtp: smtp as never });
    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    const endpoint = `http://127.0.0.1:${port}/mcp`;

    const unauthorized = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(unauthorized.status).toBe(401);

    const client = new Client({ name: 'connector-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers: { Authorization: 'Bearer 1234567890abcdef' } }
    });

    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        'get_email',
        'get_thread',
        'list_mailboxes',
        'reply_email',
        'search_emails',
        'send_email',
        'send_email_batch'
      ]);

      const result = await client.callTool({ name: 'list_mailboxes', arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.content[0]).toMatchObject({ type: 'text' });
      if (result.content[0]?.type === 'text') {
        expect(JSON.parse(result.content[0].text)).toEqual([{ path: 'INBOX', specialUse: '\\Inbox' }]);
      }
    } finally {
      await transport.terminateSession().catch(() => undefined);
      await client.close();
    }
  });
});
