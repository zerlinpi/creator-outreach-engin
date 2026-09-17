import { encodeMessageRef } from './message-ref.ts';
import type { MailAddress, NormalizedMessage } from './types.ts';

interface ParsedMailbox { name?: string; address?: string; group?: ParsedMailbox[]; }
interface ParsedAttachment { filename?: string | null; mimeType?: string; contentId?: string; content?: ArrayBuffer | Uint8Array | string; }
export interface ParsedEmailLike {
  subject?: string; messageId?: string; inReplyTo?: string; references?: string; date?: string;
  from?: ParsedMailbox; to?: ParsedMailbox[]; cc?: ParsedMailbox[]; text?: string; html?: string;
  attachments?: ParsedAttachment[];
}

function flattenAddress(address?: ParsedMailbox): MailAddress[] {
  if (!address) return [];
  if (address.group) return address.group.flatMap(flattenAddress);
  if (!address.address) return [];
  return [{ name: address.name || undefined, address: address.address }];
}

function flattenAddresses(addresses?: ParsedMailbox[]): MailAddress[] {
  return (addresses ?? []).flatMap(flattenAddress);
}

function contentSize(content: ParsedAttachment['content']): number | undefined {
  if (typeof content === 'string') return Buffer.byteLength(content);
  if (content instanceof Uint8Array) return content.byteLength;
  if (content instanceof ArrayBuffer) return content.byteLength;
  return undefined;
}

export function normalizeParsedEmail(parsed: ParsedEmailLike, meta: { mailbox: string; uid: number; unread?: boolean }): NormalizedMessage {
  const from = flattenAddress(parsed.from)[0];
  const references = (parsed.references?.match(/<[^>]+>/g) ?? []).filter((value, index, arr) => arr.indexOf(value) === index);
  return {
    connectorId: encodeMessageRef(meta.mailbox, meta.uid),
    mailbox: meta.mailbox,
    uid: meta.uid,
    messageId: parsed.messageId,
    inReplyTo: parsed.inReplyTo,
    references,
    subject: parsed.subject ?? '',
    from,
    to: flattenAddresses(parsed.to),
    cc: flattenAddresses(parsed.cc),
    date: parsed.date,
    unread: meta.unread,
    text: parsed.text ?? '',
    html: parsed.html,
    attachments: (parsed.attachments ?? []).map((attachment) => ({
      filename: attachment.filename ?? undefined,
      contentType: attachment.mimeType,
      size: contentSize(attachment.content),
      contentId: attachment.contentId,
    })),
  };
}
