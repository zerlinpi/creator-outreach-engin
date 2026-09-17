import { simpleParser } from 'mailparser';
import type { NormalizedMessage } from './types.js';
import { normalizeAddress } from './addresses.js';

type ParsedAddress = { value?: Array<{ address?: string }> };

function addresses(value: ParsedAddress | ParsedAddress[] | undefined): string[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  const seen = new Set<string>();
  const result: string[] = [];

  for (const entry of values) {
    for (const item of entry.value ?? []) {
      if (!item.address) continue;
      const address = normalizeAddress(item.address);
      if (seen.has(address)) continue;
      seen.add(address);
      result.push(address);
    }
  }

  return result;
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
    to: addresses(parsed.to),
    cc: addresses(parsed.cc),
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
