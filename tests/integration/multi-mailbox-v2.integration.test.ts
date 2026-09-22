import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createHttpApp } from '../../src/app.js';
import { MailAccountRegistry, type MailAccountRuntime } from '../../src/mail/accounts.js';
import type { NormalizedMessage, OutgoingMessage } from '../../src/mail/types.js';

const servers: Array<{ close(cb?: (err?: Error) => void): void }> = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))));

function account(id: string, failSearch = false): MailAccountRuntime & { sent: OutgoingMessage[] } {
  const sent: OutgoingMessage[] = [];
  const message: NormalizedMessage = {
    id: id + '-ref', account: id, mailbox: 'INBOX', uid: 1,
    from: ['creator@' + id + '.example'], to: [id + '@example.com'], cc: [],
    subject: 'Reply for ' + id, date: new Date(id === 'a' ? '2026-09-20T10:00:00Z' : '2026-09-21T10:00:00Z'),
    text: 'Message in ' + id, html: null, messageId: '<' + id + '@example.com>', inReplyTo: null, references: [], attachments: []
  };
  return {
    id,
    address: id + '@example.com',
    fromName: id.toUpperCase(),
    source: 'ui',
    sent,
    imap: {
      async listMailboxes() { return [{ path: 'INBOX', specialUse: '\\Inbox' }]; },
      async searchEmails() { if (failSearch) throw new Error('offline'); return [message]; },
      async getEmail() { return message; },
      async getThread() { return { messages: [message], heuristic: false }; }
    } as never,
    smtp: {
      async send(outgoing: OutgoingMessage) {
        sent.push(outgoing);
        return { accepted: outgoing.to, rejected: [], messageId: '<' + id + '-' + sent.length + '@example.com>' };
      }
    } as never
  };
}

function json(result: Awaited<ReturnType<Client['callTool']>>) {
  const item = result.content[0];
  if (!item || item.type !== 'text') throw new Error('Expected text');
  return JSON.parse(item.text);
}

describe('AI multi-mailbox clarity', () => {
  it('searches all accounts with explicit source identity and isolates failures', async () => {
    const a = account('a');
    const b = account('b');
    const broken = account('broken', true);
    const registry = new MailAccountRegistry([a, b, broken], 'a');
    const app = createHttpApp({ authToken: '1234567890abcdef1234567890abcdef', registry, allowedHosts: ['127.0.0.1'] });
    const server = app.listen(0, '127.0.0.1'); servers.push(server); await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    const client = new Client({ name: 'multi-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
    const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + port + '/mcp'), {
      requestInit: { headers: { Authorization: 'Bearer 1234567890abcdef1234567890abcdef' } }
    });
    await client.connect(transport);
    try {
      const all = json(await client.callTool({ name: 'search_emails', arguments: { all_accounts: true, limit: 20 } }));
      expect(all.scope).toBe('all_accounts');
      expect(all.results.map((x: any) => x.account)).toEqual(['b', 'a']);
      expect(all.results.every((x: any) => Boolean(x.accountAddress))).toBe(true);
      expect(all.failures).toHaveLength(1);
      expect(all.failures[0].account).toBe('broken');

      const batch = json(await client.callTool({
        name: 'send_email_batch',
        arguments: {
          idempotency_key: 'multi-account-batch-001',
          delay_ms: 0,
          messages: [
            { account: 'a', to: ['one@example.com'], subject: 'A1', text: 'A one' },
            { account: 'b', to: ['two@example.com'], subject: 'B1', text: 'B one' },
            { account: 'a', to: ['three@example.com'], subject: 'A2', text: 'A two' }
          ]
        }
      }));
      expect(batch.map((x: any) => x.account)).toEqual(['a', 'b', 'a']);
      expect(a.sent.map((m) => m.subject)).toEqual(['A1', 'A2']);
      expect(b.sent.map((m) => m.subject)).toEqual(['B1']);

      const invalid = await client.callTool({
        name: 'send_email_batch',
        arguments: {
          account: 'a',
          idempotency_key: 'multi-account-batch-002',
          messages: [{ account: 'b', to: ['x@example.com'], subject: 'bad', text: 'bad' }]
        }
      });
      expect(invalid.isError).toBe(true);
      expect(json(invalid).error.code).toBe('ACCOUNT_MISMATCH');
    } finally {
      await transport.terminateSession().catch(() => undefined);
      await client.close();
    }
  });
});
