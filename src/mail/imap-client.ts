import { createHmac, timingSafeEqual } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import type { MailRuntimeConfig } from '../config.js';
import { AsyncSemaphore } from '../concurrency.js';
import { ConnectorError } from '../errors.js';
import { parseMessage } from './parser.js';
import { normalizeSubject, resolveThread } from './threading.js';
import { pickMailboxBySpecialUse, resolveMailboxAlias, SENT_FALLBACK_NAMES } from './mailboxes.js';
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

export interface DecodedMessageRef {
  account?: string;
  mailbox: string;
  uid: number;
  uidValidity: string;
}

export function attachImapErrorListener(client: { on(event: 'error', listener: (error: unknown) => void): unknown }): void {
  client.on('error', () => undefined);
}

export function buildImapClientOptions(config: MailRuntimeConfig) {
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

export function buildSearchFetchQuery(config: MailRuntimeConfig) {
  return {
    uid: true,
    source: { start: 0, maxLength: config.searchSourceBytes },
    size: true,
    flags: true
  };
}

export function buildFullMessageFetchQuery(config: MailRuntimeConfig) {
  return {
    uid: true,
    source: { start: 0, maxLength: config.maxMessageBytes + 1 },
    size: true,
    flags: true
  };
}

export function enforceMessageSize(size: number, maxBytes: number): void {
  if (size > maxBytes) {
    throw new ConnectorError('MESSAGE_TOO_LARGE', 'Message exceeds the configured ' + maxBytes + '-byte limit.');
  }
}

function parseRefBody(body: string): DecodedMessageRef {
  const value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (
    (value.account !== undefined && (typeof value.account !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(value.account))) ||
    typeof value.mailbox !== 'string' ||
    value.mailbox.length < 1 ||
    value.mailbox.length > 1024 ||
    /[\u0000\r\n]/.test(value.mailbox) ||
    !Number.isSafeInteger(value.uid) ||
    value.uid < 1 ||
    value.uid > 0xFFFFFFFF ||
    typeof value.uidValidity !== 'string' ||
    !/^[1-9]\d{0,9}$/.test(value.uidValidity) ||
    BigInt(value.uidValidity) > 0xFFFFFFFFn
  ) {
    throw new Error('bad ref');
  }
  return {
    ...(value.account ? { account: value.account } : {}),
    mailbox: value.mailbox,
    uid: value.uid,
    uidValidity: value.uidValidity
  };
}

function validateMailboxName(value: string): string {
  const mailbox = value.trim();
  if (!mailbox || mailbox.length > 1024 || /[\u0000\r\n]/.test(mailbox)) {
    throw new ConnectorError('MAILBOX_NOT_FOUND', 'Mailbox name is invalid.');
  }
  return mailbox;
}

function safeSignatureEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function encodeMessageRef(
  mailbox: string,
  uid: number,
  uidValidity: bigint | string | number,
  account?: string,
  secret?: string
): string {
  const body = Buffer.from(JSON.stringify({
    ...(account ? { account } : {}),
    mailbox,
    uid,
    uidValidity: String(uidValidity)
  }), 'utf8').toString('base64url');

  if (!secret) return body;
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return 'mr1.' + body + '.' + signature;
}

export function decodeMessageRef(ref: string, secret?: string, allowLegacy = false): DecodedMessageRef {
  try {
    if (secret) {
      if (!ref.startsWith('mr1.')) {
        if (!allowLegacy) throw new Error('unsigned legacy ref is not allowed');
        return parseRefBody(ref);
      }
      const [version, body, signature, extra] = ref.split('.');
      if (version !== 'mr1' || !body || !signature || extra) throw new Error('bad signed ref');
      const expected = createHmac('sha256', secret).update(body).digest('base64url');
      if (!safeSignatureEqual(signature, expected)) throw new Error('bad signature');
      return parseRefBody(body);
    }

    if (ref.startsWith('mr1.')) throw new Error('signed ref requires verification secret');
    return parseRefBody(ref);
  } catch {
    throw new ConnectorError('MESSAGE_NOT_FOUND', 'Invalid or tampered message reference.');
  }
}

function classifyImapError(error: unknown): ConnectorError {
  const value = error as { code?: string; authenticationFailed?: boolean; responseText?: string; message?: string } | undefined;
  const text = (value?.code ?? '') + ' ' + (value?.responseText ?? '') + ' ' + (value?.message ?? '');
  const normalized = text.toLowerCase();
  if (value?.authenticationFailed || normalized.includes('authentication') || normalized.includes('auth failed')) {
    return new ConnectorError('AUTH_FAILED', 'Mailbox authentication failed.', { cause: error });
  }
  return new ConnectorError('IMAP_UNAVAILABLE', 'Mailbox access failed.', { cause: error });
}

function dedupeMessages(messages: NormalizedMessage[]): NormalizedMessage[] {
  const seen = new Set<string>();
  const out: NormalizedMessage[] = [];
  for (const message of messages) {
    const key = message.messageId ?? (message.account ?? '') + ':' + message.mailbox + ':' + message.uid;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(message);
  }
  return out;
}

export class ImapMailClient {
  private readonly semaphore: AsyncSemaphore;
  private enabled = true;

  constructor(
    private readonly config: MailRuntimeConfig,
    readonly accountId: string = 'default',
    private readonly messageRefSecret?: string
  ) {
    this.semaphore = new AsyncSemaphore(config.imap.maxConcurrency ?? 2, 100);
  }

  disable(): void {
    this.enabled = false;
  }

  private createClient() {
    const client = new ImapFlow(buildImapClientOptions(this.config));
    attachImapErrorListener(client);
    return client;
  }

  private withClient<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    return this.semaphore.run(async () => {
      if (!this.enabled) throw new ConnectorError('ACCOUNT_NOT_FOUND', 'Mail account configuration changed or was removed.');
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
    });
  }

  async listMailboxes() {
    return this.withClient(async (client) =>
      (await client.list()).map((box) => ({ path: box.path, specialUse: box.specialUse ?? null }))
    );
  }

  private async sentMailbox(): Promise<string | null> {
    const boxes = await this.listMailboxes();
    const sent = pickMailboxBySpecialUse(boxes, '\\Sent', SENT_FALLBACK_NAMES);
    return sent ? validateMailboxName(sent) : null;
  }

  private async resolveSearchMailbox(requested?: string): Promise<string> {
    const normalized = requested?.trim().toUpperCase();
    if (!normalized || normalized === 'INBOX' || normalized === '\\INBOX') return 'INBOX';
    if (normalized === 'SENT' || normalized === '\\SENT') {
      return validateMailboxName(resolveMailboxAlias(requested, await this.listMailboxes()));
    }
    return validateMailboxName(requested!);
  }

  async searchEmails(criteria: SearchCriteria): Promise<NormalizedMessage[]> {
    const mailbox = await this.resolveSearchMailbox(criteria.mailbox);
    const limit = Math.max(1, Math.min(criteria.limit ?? 20, 100));

    return this.withClient(async (client) => {
      const opened = await client.mailboxOpen(mailbox);
      const uidValidity = opened.uidValidity;
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
      for await (const item of client.fetch(selected, buildSearchFetchQuery(this.config), { uid: true })) {
        if (!item.source) continue;
        const uid = item.uid;
        const fullSize = typeof item.size === 'number' ? item.size : item.source.length;
        const truncated = fullSize > item.source.length;
        out.push({
          ...(await parseMessage(item.source, {
            id: encodeMessageRef(mailbox, uid, uidValidity, this.accountId, this.messageRefSecret),
            account: this.accountId,
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
    const { account, mailbox, uid, uidValidity } = decodeMessageRef(ref, this.messageRefSecret, true);
    if (account && account !== this.accountId) {
      throw new ConnectorError('ACCOUNT_MISMATCH', 'The message reference belongs to a different mail account.');
    }

    return this.withClient(async (client) => {
      const opened = await client.mailboxOpen(mailbox);
      if (String(opened.uidValidity) !== uidValidity) {
        throw new ConnectorError('MESSAGE_NOT_FOUND', 'Message reference is stale because the mailbox identity changed.');
      }
      for await (const item of client.fetch([uid], buildFullMessageFetchQuery(this.config), { uid: true })) {
        if (item.source) {
          const fullSize = typeof item.size === 'number' ? item.size : item.source.length;
          enforceMessageSize(Math.max(fullSize, item.source.length), this.config.maxMessageBytes);
          return parseMessage(item.source, {
            id: ref,
            account: this.accountId,
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
      const subject = normalizeSubject(anchor.subject);
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
