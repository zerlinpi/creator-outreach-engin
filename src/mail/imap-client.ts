import { ImapFlow } from 'imapflow';
import type { AppConfig } from '../config.js';
import { ConnectorError } from '../errors.js';
import { parseMessage } from './parser.js';
import { resolveThread } from './threading.js';
import { pickMailboxBySpecialUse, resolveMailboxAlias } from './mailboxes.js';
import type { NormalizedMessage, ThreadResult } from './types.js';

export interface SearchCriteria {
  query?: string;
  from?: string;
  to?: string;
  subject?: string;
  mailbox?: string;
  unread?: boolean;
  since?: Date;
  before?: Date;
  limit?: number;
}

export function buildImapClientOptions(config: AppConfig) {
  return {
    host: config.imap.host,
    port: config.imap.port,
    secure: true,
    auth: { user: config.username, pass: config.appPassword },
    logger: false as const,
    connectionTimeout: config.imap.connectionTimeout,
    greetingTimeout: config.imap.greetingTimeout,
    socketTimeout: config.imap.socketTimeout
  };
}

export function enforceMessageSize(size: number, maxBytes: number): void {
  if (size > maxBytes) {
    throw new ConnectorError('MESSAGE_TOO_LARGE', `Message exceeds the configured ${maxBytes}-byte limit.`);
  }
}

export function encodeMessageRef(mailbox: string, uid: number): string {
  return Buffer.from(JSON.stringify({ mailbox, uid }), 'utf8').toString('base64url');
}

export function decodeMessageRef(ref: string): { mailbox: string; uid: number } {
  try {
    const value = JSON.parse(Buffer.from(ref, 'base64url').toString('utf8'));
    if (typeof value.mailbox !== 'string' || !Number.isInteger(value.uid) || value.uid < 1) throw new Error('bad ref');
    return value;
  } catch {
    throw new ConnectorError('MESSAGE_NOT_FOUND', 'Invalid message reference.');
  }
}

function classifyImapError(error: unknown): ConnectorError {
  const value = error as { code?: string; authenticationFailed?: boolean; responseText?: string; message?: string } | undefined;
  const text = `${value?.code ?? ''} ${value?.responseText ?? ''} ${value?.message ?? ''}`.toLowerCase();
  if (value?.authenticationFailed || text.includes('authentication') || text.includes('auth failed')) {
    return new ConnectorError('AUTH_FAILED', 'Mailbox authentication failed.', { cause: error });
  }
  return new ConnectorError('IMAP_UNAVAILABLE', 'Mailbox access failed.', { cause: error });
}

function dedupeMessages(messages: NormalizedMessage[]): NormalizedMessage[] {
  const seen = new Set<string>();
  const out: NormalizedMessage[] = [];
  for (const message of messages) {
    const key = message.messageId ?? `${message.mailbox}:${message.uid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(message);
  }
  return out;
}

export class ImapMailClient {
  constructor(private readonly config: AppConfig) {}

  private createClient() {
    return new ImapFlow(buildImapClientOptions(this.config));
  }

  private async withClient<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = this.createClient();
    try {
      await client.connect();
      return await fn(client);
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw classifyImapError(error);
    } finally {
      try {
        if (client.usable) await client.logout();
      } catch {}
    }
  }

  async listMailboxes() {
    return this.withClient(async (client) =>
      (await client.list()).map((box) => ({ path: box.path, specialUse: box.specialUse ?? null }))
    );
  }

  private async sentMailbox(): Promise<string | null> {
    const boxes = await this.listMailboxes();
    return pickMailboxBySpecialUse(boxes, '\\Sent', ['Sent', 'Sent Messages', '已发送', '已发送邮件']);
  }

  private async resolveSearchMailbox(requested?: string): Promise<string> {
    const normalized = requested?.trim().toUpperCase();
    if (!normalized || normalized === 'INBOX' || normalized === '\\INBOX') return 'INBOX';
    if (normalized === 'SENT' || normalized === '\\SENT') {
      return resolveMailboxAlias(requested, await this.listMailboxes());
    }
    return requested!.trim();
  }

  async searchEmails(criteria: SearchCriteria): Promise<NormalizedMessage[]> {
    const mailbox = await this.resolveSearchMailbox(criteria.mailbox);
    const limit = Math.max(1, Math.min(criteria.limit ?? 20, 100));

    return this.withClient(async (client) => {
      await client.mailboxOpen(mailbox);
      const query: Record<string, unknown> = {};
      if (criteria.from) query.from = criteria.from;
      if (criteria.to) query.to = criteria.to;
      if (criteria.subject) query.subject = criteria.subject;
      if (criteria.query) query.body = criteria.query;
      if (criteria.unread !== undefined) query.seen = !criteria.unread;
      if (criteria.since) query.since = criteria.since;
      if (criteria.before) query.before = criteria.before;

      const found = await client.search(query, { uid: true });
      const uids = found || [];
      const selected = uids.slice(-limit).reverse();
      if (selected.length === 0) return [];

      const out: NormalizedMessage[] = [];
      for await (const item of client.fetch(selected, { uid: true, source: true, flags: true }, { uid: true })) {
        if (!item.source) continue;
        const uid = item.uid;
        const truncated = item.source.length > this.config.searchSourceBytes;
        const source = truncated ? item.source.subarray(0, this.config.searchSourceBytes) : item.source;
        out.push({
          ...(await parseMessage(source, {
            id: encodeMessageRef(mailbox, uid),
            mailbox,
            uid,
            unread: !item.flags?.has('\\Seen')
          })),
          truncated
        });
      }

      return out.sort((a, b) => b.date.getTime() - a.date.getTime());
    });
  }

  async getEmail(ref: string): Promise<NormalizedMessage> {
    const { mailbox, uid } = decodeMessageRef(ref);
    return this.withClient(async (client) => {
      await client.mailboxOpen(mailbox);
      for await (const item of client.fetch([uid], { uid: true, source: true, flags: true }, { uid: true })) {
        if (item.source) {
          enforceMessageSize(item.source.length, this.config.maxMessageBytes);
          return parseMessage(item.source, {
            id: ref,
            mailbox,
            uid,
            unread: !item.flags?.has('\\Seen')
          });
        }
      }
      throw new ConnectorError('MESSAGE_NOT_FOUND', 'Message was not found.');
    });
  }

  async getThread(input: { messageRef?: string; participant?: string; subject?: string }): Promise<ThreadResult> {
    const sent = await this.sentMailbox();

    if (input.messageRef) {
      const anchor = await this.getEmail(input.messageRef);
      const subject = normalizeSearchSubject(anchor.subject);
      const mailboxes = new Set<string>(['INBOX', anchor.mailbox]);
      if (sent) mailboxes.add(sent);

      const pools = await Promise.all(
        [...mailboxes].map((mailbox) => this.searchEmails({ mailbox, subject, limit: 100 }))
      );
      const messages = dedupeMessages([anchor, ...pools.flat()]);
      return resolveThread(messages, anchor);
    }

    if (!input.participant) {
      throw new ConnectorError('THREAD_NOT_FOUND', 'Provide a message reference or participant.');
    }

    const searches: Array<Promise<NormalizedMessage[]>> = [
      this.searchEmails({ from: input.participant, subject: input.subject, mailbox: 'INBOX', limit: 100 })
    ];
    if (sent) {
      searches.push(
        this.searchEmails({ to: input.participant, subject: input.subject, mailbox: sent, limit: 100 })
      );
    }

    const messages = dedupeMessages((await Promise.all(searches)).flat());
    if (!messages.length) {
      throw new ConnectorError('THREAD_NOT_FOUND', 'No matching thread was found.');
    }

    const anchor = [...messages].sort((a, b) => b.date.getTime() - a.date.getTime())[0];
    return resolveThread(messages, anchor);
  }
}

function normalizeSearchSubject(subject: string): string {
  return subject.replace(/^(re|fw|fwd)\s*:\s*/ig, '').trim();
}
