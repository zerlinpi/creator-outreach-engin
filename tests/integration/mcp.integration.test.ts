import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createHttpApp } from '../../src/app.js';
import { encodeMessageRef } from '../../src/mail/imap-client.js';
import type { NormalizedMessage, OutgoingMessage } from '../../src/mail/types.js';

const servers: Array<{ close(cb?: (err?: Error) => void): void }> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

const inbound: NormalizedMessage = {
  id: 'inbox-ref',
  mailbox: 'INBOX',
  uid: 10,
  from: ['creator@example.com'],
  to: ['campx@example.com'],
  cc: [],
  subject: 'CAMPX collaboration',
  date: new Date('2026-09-17T10:00:00Z'),
  text: 'I am interested in working together. Please send details.',
  html: '<p>I am <b>interested</b>.</p><script>bad()</script>',
  messageId: '<creator-reply@example.com>',
  inReplyTo: '<campx-root@example.com>',
  references: ['<campx-root@example.com>'],
  attachments: [],
  unread: true
};

const outbound: NormalizedMessage = {
  ...inbound,
  id: 'sent-ref',
  mailbox: 'Sent Messages',
  uid: 11,
  from: ['campx@example.com'],
  to: ['creator@example.com'],
  subject: 'CAMPX collaboration',
  date: new Date('2026-09-17T09:00:00Z'),
  text: 'Initial CAMPX outreach.',
  html: null,
  messageId: '<campx-root@example.com>',
  inReplyTo: null,
  references: [],
  unread: false
};

function fakeAdapters() {
  const sent: OutgoingMessage[] = [];
  const imap = {
    async listMailboxes() {
      return [
        { path: 'INBOX', specialUse: '\\Inbox' },
        { path: 'Sent Messages', specialUse: '\\Sent' }
      ];
    },
    async searchEmails() { return [inbound]; },
    async getEmail(ref: string) {
      if (ref === 'sent-ref') return outbound;
      return inbound;
    },
    async getThread() { return { messages: [outbound, inbound], heuristic: false }; }
  };
  const smtp = {
    async send(message: OutgoingMessage) {
      sent.push(message);
      return { accepted: message.to, rejected: [], messageId: '<sent-' + sent.length + '@example.com>' };
    }
  };
  return { imap, smtp, sent };
}

async function connectApp(app: ReturnType<typeof createHttpApp>, sent: OutgoingMessage[] | Record<string, OutgoingMessage[]>) {
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  const endpoint = 'http://127.0.0.1:' + port + '/mcp';

  const client = new Client({ name: 'connector-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { Authorization: 'Bearer 1234567890abcdef' } }
  });
  await client.connect(transport);
  return { client, transport, endpoint, sent };
}

async function openClient() {
  const { imap, smtp, sent } = fakeAdapters();
  const app = createHttpApp({
    authToken: '1234567890abcdef',
    mailboxAddress: 'campx@example.com',
    allowedHosts: ['127.0.0.1'],
    imap: imap as never,
    smtp: smtp as never
  });
  return connectApp(app, sent);
}

function multiAccountAdapters(id: string, address: string) {
  const sent: OutgoingMessage[] = [];
  const inboxRef = encodeMessageRef('INBOX', 10, 77, id);
  const message: NormalizedMessage = {
    ...inbound,
    id: inboxRef,
    account: id,
    to: [address]
  };
  const imap = {
    async listMailboxes() {
      return [{ path: 'INBOX', specialUse: '\\Inbox' }];
    },
    async searchEmails() { return [message]; },
    async getEmail() { return message; },
    async getThread() { return { messages: [message], heuristic: false }; }
  };
  const smtp = {
    async send(outgoing: OutgoingMessage) {
      sent.push(outgoing);
      return { accepted: outgoing.to, rejected: [], messageId: '<' + id + '-' + sent.length + '@example.com>' };
    }
  };
  return { id, address, fromName: id.toUpperCase(), imap: imap as never, smtp: smtp as never, sent, inboxRef };
}

async function openMultiClient() {
  const campx = multiAccountAdapters('campx', 'campx@example.com');
  const hassky = multiAccountAdapters('hassky', 'hassky@example.com');
  const app = createHttpApp({
    authToken: '1234567890abcdef',
    accounts: [campx, hassky],
    defaultAccount: 'campx',
    allowedHosts: ['127.0.0.1']
  });
  const connected = await connectApp(app, { campx: campx.sent, hassky: hassky.sent });
  return { ...connected, campx, hassky };
}

function jsonText(result: Awaited<ReturnType<Client['callTool']>>) {
  const item = result.content[0];
  expect(item).toMatchObject({ type: 'text' });
  if (!item || item.type !== 'text') throw new Error('Expected text tool result');
  return JSON.parse(item.text);
}

describe('remote MCP HTTP surface', () => {
  it('rejects unauthenticated MCP requests and exposes exactly seven mail tools', async () => {
    const { client, transport, endpoint } = await openClient();
    const unauthorized = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(unauthorized.status).toBe(401);

    try {
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
      expect(jsonText(await client.callTool({ name: 'list_mailboxes', arguments: {} }))).toEqual([
        { path: 'INBOX', specialUse: '\\Inbox' },
        { path: 'Sent Messages', specialUse: '\\Sent' }
      ]);
    } finally {
      await transport.terminateSession().catch(() => undefined);
      await client.close();
    }
  });

  it('returns compact search results and explicit full-message/thread views', async () => {
    const { client, transport } = await openClient();
    try {
      const search = jsonText(await client.callTool({ name: 'search_emails', arguments: { from: 'creator@example.com' } }));
      expect(search[0]).toMatchObject({ id: 'inbox-ref', account: 'default', externalContent: true, preview: expect.any(String) });
      expect(search[0]).not.toHaveProperty('text');
      expect(search[0]).not.toHaveProperty('html');

      const email = jsonText(await client.callTool({ name: 'get_email', arguments: { message_ref: 'inbox-ref' } }));
      expect(email).toMatchObject({ id: 'inbox-ref', account: 'default', text: inbound.text, externalContent: true });
      expect(email).not.toHaveProperty('html');

      const htmlEmail = jsonText(await client.callTool({ name: 'get_email', arguments: { message_ref: 'inbox-ref', include_html: true } }));
      expect(htmlEmail.html).toContain('<b>interested</b>');
      expect(htmlEmail.html).not.toContain('<script');

      const thread = jsonText(await client.callTool({ name: 'get_thread', arguments: { participant: 'creator@example.com' } }));
      expect(thread.account).toBe('default');
      expect(thread.heuristic).toBe(false);
      expect(thread.messages).toHaveLength(2);
      expect(thread.messages.every((message: { externalContent?: boolean }) => message.externalContent === true)).toBe(true);
    } finally {
      await transport.terminateSession().catch(() => undefined);
      await client.close();
    }
  });

  it('sends, replies, follows up from Sent, and batch-sends as separate messages', async () => {
    const { client, transport, sent } = await openClient();
    try {
      const sendResult = jsonText(await client.callTool({
        name: 'send_email',
        arguments: {
          to: ['first@example.com'],
          subject: 'CAMPX hello',
          text: 'Hello from CAMPX',
          idempotency_key: 'integration-send-001'
        }
      }));
      expect(sendResult).toMatchObject({ account: 'default', accepted: ['first@example.com'] });
      expect((sent as OutgoingMessage[])[0]).toMatchObject({ to: ['first@example.com'], subject: 'CAMPX hello' });

      jsonText(await client.callTool({
        name: 'reply_email',
        arguments: {
          message_ref: 'inbox-ref',
          text: 'Thanks for getting back to us.',
          idempotency_key: 'integration-reply-inbound-001'
        }
      }));
      expect((sent as OutgoingMessage[])[1]).toMatchObject({
        to: ['creator@example.com'],
        inReplyTo: '<creator-reply@example.com>',
        references: ['<campx-root@example.com>', '<creator-reply@example.com>']
      });

      jsonText(await client.callTool({
        name: 'reply_email',
        arguments: {
          message_ref: 'sent-ref',
          text: 'Just following up.',
          idempotency_key: 'integration-followup-001'
        }
      }));
      expect((sent as OutgoingMessage[])[2]).toMatchObject({ to: ['creator@example.com'], inReplyTo: '<campx-root@example.com>' });

      const batch = jsonText(await client.callTool({
        name: 'send_email_batch',
        arguments: {
          idempotency_key: 'integration-batch-001',
          messages: [
            { to: ['a@example.com'], subject: 'CAMPX A', text: 'Hi A' },
            { to: ['b@example.com'], subject: 'CAMPX B', text: 'Hi B' }
          ]
        }
      }));
      expect(batch).toHaveLength(2);
      expect(batch.every((entry: { ok: boolean }) => entry.ok)).toBe(true);
      expect((sent as OutgoingMessage[]).slice(3).map((message) => message.to)).toEqual([['a@example.com'], ['b@example.com']]);
    } finally {
      await transport.terminateSession().catch(() => undefined);
      await client.close();
    }
  });

  it('isolates account routing, idempotency, and reply identity across multiple mailboxes', async () => {
    const { client, transport, campx, hassky } = await openMultiClient();
    try {
      const mailboxes = jsonText(await client.callTool({ name: 'list_mailboxes', arguments: {} }));
      expect(mailboxes.defaultAccount).toBe('campx');
      expect(mailboxes.accounts.map((entry: { account: string }) => entry.account)).toEqual(['campx', 'hassky']);

      const sharedKey = 'same-business-key-001';
      const campxSend = jsonText(await client.callTool({
        name: 'send_email',
        arguments: {
          account: 'campx',
          to: ['creator@example.com'],
          subject: 'CAMPX',
          text: 'Campx body',
          idempotency_key: sharedKey
        }
      }));
      const hasskySend = jsonText(await client.callTool({
        name: 'send_email',
        arguments: {
          account: 'hassky',
          to: ['creator@example.com'],
          subject: 'HASSKY',
          text: 'Hassky body',
          idempotency_key: sharedKey
        }
      }));

      expect(campxSend.account).toBe('campx');
      expect(hasskySend.account).toBe('hassky');
      expect(campx.sent).toHaveLength(1);
      expect(hassky.sent).toHaveLength(1);

      await client.callTool({
        name: 'send_email',
        arguments: {
          to: ['default@example.com'],
          subject: 'Default sender',
          text: 'Uses campx',
          idempotency_key: 'default-account-001'
        }
      });
      expect(campx.sent).toHaveLength(2);

      const mismatch = await client.callTool({
        name: 'reply_email',
        arguments: {
          account: 'campx',
          message_ref: hassky.inboxRef,
          text: 'Wrong account attempt',
          idempotency_key: 'wrong-account-001'
        }
      });
      expect(mismatch.isError).toBe(true);
      expect(jsonText(mismatch)).toMatchObject({ error: { code: 'ACCOUNT_MISMATCH' } });
      expect(campx.sent).toHaveLength(2);
      expect(hassky.sent).toHaveLength(1);
    } finally {
      await transport.terminateSession().catch(() => undefined);
      await client.close();
    }
  });
});
