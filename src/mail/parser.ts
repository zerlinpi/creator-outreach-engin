import { simpleParser } from 'mailparser';
import type { NormalizedMessage } from './types.js';
import { normalizeAddress } from './addresses.js';

function addresses(value: { value?: Array<{ address?: string }> } | undefined): string[] {
  return (value?.value ?? []).flatMap((item) => item.address ? [normalizeAddress(item.address)] : []);
}

export async function parseMessage(source: Buffer | string, meta: { id: string; mailbox: string; uid: number; unread?: boolean }): Promise<NormalizedMessage> {
  const parsed = await simpleParser(source);
  const refs = parsed.references ? (Array.isArray(parsed.references) ? parsed.references : [parsed.references]) : [];
  return {
    id: meta.id,
    mailbox: meta.mailbox,
    uid: meta.uid,
    from: addresses(parsed.from),
    replyTo: addresses(parsed.replyTo),
    to: addresses(parsed.to && !Array.isArray(parsed.to) ? parsed.to : undefined),
    cc: addresses(parsed.cc && !Array.isArray(parsed.cc) ? parsed.cc : undefined),
    subject: parsed.subject ?? '',
    date: parsed.date ?? new Date(0),
    text: parsed.text ?? '',
    html: typeof parsed.html === 'string' ? parsed.html : null,
    messageId: parsed.messageId ?? null,
    inReplyTo: parsed.inReplyTo ?? null,
    references: refs.filter(Boolean),
    attachments: parsed.attachments.map((a) => ({
      filename: a.filename ?? null,
      contentType: a.contentType,
      size: a.size,
      contentDisposition: a.contentDisposition ?? null,
      cid: a.cid ?? null
    })),
    unread: meta.unread
  };
}
