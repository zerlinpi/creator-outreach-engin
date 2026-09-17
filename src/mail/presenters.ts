import type { NormalizedMessage } from './types.js';

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function preview(value: string, max = 280): string {
  const compact = compactWhitespace(value);
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}

export function sanitizeHtmlForTool(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<(iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript\s*:/gi, '');
}

export function toSearchSummary(message: NormalizedMessage) {
  return {
    id: message.id,
    mailbox: message.mailbox,
    from: message.from,
    to: message.to,
    subject: message.subject,
    date: message.date,
    unread: message.unread ?? false,
    preview: preview(message.text),
    hasAttachments: message.attachments.length > 0,
    messageId: message.messageId,
    externalContent: true
  };
}

export function toEmailView(message: NormalizedMessage, includeHtml = false) {
  const base = {
    id: message.id,
    mailbox: message.mailbox,
    uid: message.uid,
    from: message.from,
    to: message.to,
    cc: message.cc,
    subject: message.subject,
    date: message.date,
    text: message.text,
    messageId: message.messageId,
    inReplyTo: message.inReplyTo,
    references: message.references,
    attachments: message.attachments,
    unread: message.unread ?? false,
    externalContent: true
  };

  if (!includeHtml || !message.html) return base;
  return { ...base, html: sanitizeHtmlForTool(message.html) };
}
