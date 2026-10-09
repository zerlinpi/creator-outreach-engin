import { AsyncSemaphore } from './concurrency.js';
import { normalizeSubject } from './mail/threading.js';
import { toSearchSummary, type SearchEmailSummary } from './mail/presenters.js';
import type { MailAccountRegistry, MailAccountRuntime } from './mail/accounts.js';
import type { NormalizedMessage } from './mail/types.js';

export type OutreachStage =
  | 'new_contact'
  | 'awaiting_reply'
  | 'followed_up'
  | 'creator_replied'
  | 'replied'
  | 'we_replied'
  | 'possible_reply'
  | 'inbound';

export interface OutreachConversation {
  account: string;
  accountAddress: string;
  participant: string;
  subject: string;
  stage: OutreachStage;
  needsAttention: boolean;
  unread: boolean;
  sentCount: number;
  receivedCount: number;
  lastActivity: string;
  lastDirection: 'inbound' | 'outbound';
  latest: SearchEmailSummary;
  /** Subject + participant grouping is approximate, not an RFC conversation ID. */
  approximateGrouping: true;
}

export interface OutreachOverview {
  generatedAt: string;
  perFolderLimit: number;
  limitedHistory: true;
  conversations: OutreachConversation[];
  errors: Array<{ account: string; folder: 'INBOX' | 'SENT'; error: string }>;
}

const MAX_OVERVIEW_ITEMS = 200;
const RECENT_REPLY_MS = 48 * 60 * 60 * 1000;
const FOLLOW_UP_MS = 72 * 60 * 60 * 1000;

function normalizeAddress(value: string): string {
  const match = value.match(/<([^<>\s]+@[^<>\s]+)>/);
  return (match ? match[1] : value).trim().toLowerCase();
}

function participantFor(message: NormalizedMessage, ownAddress: string, outbound: boolean): string | null {
  const own = normalizeAddress(ownAddress);
  const addresses = outbound ? [...message.to, ...message.cc] : message.from;
  return addresses.map(normalizeAddress).find((address) => address.includes('@') && address !== own) ?? null;
}

function hasConfirmedReply(inbound: NormalizedMessage, outbound: NormalizedMessage[]): boolean {
  const sentIds = new Set(outbound.map((m) => m.messageId).filter((id): id is string => Boolean(id)));
  return Boolean(inbound.inReplyTo && sentIds.has(inbound.inReplyTo)) ||
    inbound.references.some((ref) => sentIds.has(ref));
}

/**
 * Read-only view over the most recent IMAP samples. Never infer a confirmed
 * response from an identical subject alone. Never combine distinct accounts.
 */
export function classifyOutreachMessages(
  account: string,
  accountAddress: string,
  incoming: NormalizedMessage[],
  sent: NormalizedMessage[],
  now = new Date()
): OutreachConversation[] {
  const groups = new Map<string, Array<{ message: NormalizedMessage; outbound: boolean; participant: string }>>();
  for (const [messages, outbound] of [[incoming, false], [sent, true]] as const) {
    for (const message of messages) {
      const participant = participantFor(message, accountAddress, outbound);
      if (!participant) continue;
      const subject = normalizeSubject(message.subject).toLocaleLowerCase('en-US');
      const key = JSON.stringify([participant, subject]);
      const group = groups.get(key) ?? [];
      if (!group.some((item) => item.message.id === message.id)) {
        group.push({ message, outbound, participant });
      }
      groups.set(key, group);
    }
  }

  return [...groups.values()].map((group) => {
    group.sort((a, b) => a.message.date.getTime() - b.message.date.getTime());
    const outgoing = group.filter((item) => item.outbound).map((item) => item.message);
    const received = group.filter((item) => !item.outbound).map((item) => item.message);
    const latest = group[group.length - 1];
    const lastOutbound = outgoing[outgoing.length - 1];
    const lastInbound = received[received.length - 1];
    const latestAt = latest.message.date.getTime();
    let stage: OutreachStage;
    if (!outgoing.length) stage = 'inbound';
    else if (!received.length) {
      stage = outgoing.length > 1 ? 'followed_up' :
        now.getTime() - latestAt < RECENT_REPLY_MS ? 'new_contact' : 'awaiting_reply';
    } else if (!latest.outbound) {
      const confirmed = hasConfirmedReply(latest.message, outgoing);
      stage = !confirmed ? 'possible_reply' :
        now.getTime() - latestAt <= RECENT_REPLY_MS ? 'creator_replied' : 'replied';
    } else {
      stage = 'we_replied';
    }

    const noObservedReplyAfterSend = Boolean(lastOutbound &&
      (!lastInbound || lastInbound.date.getTime() <= lastOutbound.date.getTime()));
    const needsAttention = noObservedReplyAfterSend &&
      now.getTime() - (lastOutbound?.date.getTime() ?? 0) >= FOLLOW_UP_MS;

    return {
      account, accountAddress, participant: latest.participant,
      subject: normalizeSubject(latest.message.subject) || '(No subject)',
      stage, needsAttention, unread: group.some((item) => !item.outbound && item.message.unread),
      sentCount: outgoing.length, receivedCount: received.length,
      lastActivity: latest.message.date.toISOString(),
      lastDirection: latest.outbound ? 'outbound' as const : 'inbound' as const,
      latest: toSearchSummary(latest.message),
      approximateGrouping: true as const
    };
  }).sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
}

export async function loadOutreachOverview(
  registry: MailAccountRegistry,
  account: string,
  perFolderLimit = 25,
  now = new Date()
): Promise<OutreachOverview> {
  const limit = Math.max(1, Math.min(40, Math.floor(perFolderLimit)));
  const accounts: MailAccountRuntime[] = account === 'all' ? registry.list() : [registry.resolve(account)];
  const semaphore = new AsyncSemaphore(3, 100);
  const errors: OutreachOverview['errors'] = [];
  const collected = await Promise.all(accounts.map((runtime) => semaphore.run(async () => {
    const [incoming, sent] = await Promise.allSettled([
      runtime.imap.searchEmails({ mailbox: 'INBOX', limit }),
      runtime.imap.searchEmails({ mailbox: 'SENT', limit })
    ]);
    // A missing or inaccessible side makes reply status indeterminate.
    for (const [folder, result] of [['INBOX', incoming], ['SENT', sent]] as const) {
      if (result.status === 'rejected') {
        errors.push({ account: runtime.id, folder, error: 'Mailbox scan failed. Check connection and folder mapping.' });
      }
    }
    if (incoming.status !== 'fulfilled' || sent.status !== 'fulfilled') return [];
    return classifyOutreachMessages(runtime.id, runtime.address, incoming.value, sent.value, now);
  })));
  return {
    generatedAt: now.toISOString(), perFolderLimit: limit, limitedHistory: true,
    conversations: collected.flat().sort((a, b) => b.lastActivity.localeCompare(a.lastActivity)).slice(0, MAX_OVERVIEW_ITEMS),
    errors
  };
}
