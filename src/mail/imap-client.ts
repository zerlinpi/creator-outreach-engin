import { ImapFlow } from 'imapflow';
import type { AppConfig } from '../config.js';
import { ConnectorError } from '../errors.js';
import { parseMessage } from './parser.js';
import { resolveThread } from './threading.js';
import type { NormalizedMessage, ThreadResult } from './types.js';

export interface SearchCriteria {
  query?: string; from?: string; to?: string; subject?: string; mailbox?: string; unread?: boolean; since?: Date; before?: Date; limit?: number;
}

export function encodeMessageRef(mailbox: string, uid: number): string {
  return Buffer.from(JSON.stringify({ mailbox, uid }), 'utf8').toString('base64url');
}
export function decodeMessageRef(ref: string): { mailbox: string; uid: number } {
  try {
    const value = JSON.parse(Buffer.from(ref, 'base64url').toString('utf8'));
    if (typeof value.mailbox !== 'string' || !Number.isInteger(value.uid) || value.uid < 1) throw new Error('bad ref');
    return value;
  } catch { throw new ConnectorError('MESSAGE_NOT_FOUND', 'Invalid message reference.'); }
}

export class ImapMailClient {
  constructor(private readonly config: AppConfig) {}

  private createClient() {
    return new ImapFlow({ host: this.config.imap.host, port: this.config.imap.port, secure: true, auth: { user: this.config.username, pass: this.config.appPassword }, logger: false });
  }

  private async withClient<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = this.createClient();
    try { await client.connect(); return await fn(client); }
    catch (error) { if (error instanceof ConnectorError) throw error; throw new ConnectorError('IMAP_UNAVAILABLE', 'Mailbox access failed.', { cause: error }); }
    finally { try { if (client.usable) await client.logout(); } catch {} }
  }

  async listMailboxes() {
    return this.withClient(async (client) => (await client.list()).map((box) => ({ path: box.path, specialUse: box.specialUse ?? null })));
  }

  async searchEmails(criteria: SearchCriteria): Promise<NormalizedMessage[]> {
    const mailbox = criteria.mailbox ?? 'INBOX';
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
      const uids = await client.search(query, { uid: true });
      const selected = uids.slice(-limit).reverse();
      const out: NormalizedMessage[] = [];
      for await (const item of client.fetch(selected, { uid: true, source: true, flags: true }, { uid: true })) {
        if (!item.source) continue;
        const uid = item.uid;
        out.push(await parseMessage(item.source, { id: encodeMessageRef(mailbox, uid), mailbox, uid, unread: !item.flags?.has('\\Seen') }));
      }
      return out.sort((a,b) => b.date.getTime() - a.date.getTime());
    });
  }

  async getEmail(ref: string): Promise<NormalizedMessage> {
    const { mailbox, uid } = decodeMessageRef(ref);
    return this.withClient(async (client) => {
      await client.mailboxOpen(mailbox);
      for await (const item of client.fetch([uid], { uid: true, source: true, flags: true }, { uid: true })) {
        if (item.source) return parseMessage(item.source, { id: ref, mailbox, uid, unread: !item.flags?.has('\\Seen') });
      }
      throw new ConnectorError('MESSAGE_NOT_FOUND', 'Message was not found.');
    });
  }

  async getThread(input: { messageRef?: string; participant?: string; subject?: string }): Promise<ThreadResult> {
    if (input.messageRef) {
      const anchor = await this.getEmail(input.messageRef);
      const pool = await this.searchEmails({ mailbox: anchor.mailbox, subject: normalizeSearchSubject(anchor.subject), limit: 100 });
      return resolveThread(pool, anchor);
    }
    if (!input.participant) throw new ConnectorError('THREAD_NOT_FOUND', 'Provide a message reference or participant.');
    const inbound = await this.searchEmails({ from: input.participant, subject: input.subject, limit: 100 });
    const outbound = await this.searchEmails({ to: input.participant, subject: input.subject, mailbox: 'Sent', limit: 100 }).catch(() => []);
    const messages = [...inbound, ...outbound];
    if (!messages.length) throw new ConnectorError('THREAD_NOT_FOUND', 'No matching thread was found.');
    return resolveThread(messages, messages[0]);
  }
}

function normalizeSearchSubject(subject: string): string { return subject.replace(/^(re|fw|fwd)\s*:\s*/ig, '').trim(); }
