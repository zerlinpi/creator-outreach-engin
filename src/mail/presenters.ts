import type { AttachmentMeta, NormalizedMessage } from './types.js';

export interface SearchEmailSummary {
  id: string;
  account?: string;
  mailbox: string;
  from: string[];
  to: string[];
  subject: string;
  date: Date;
  unread: boolean;
  preview: string;
  hasAttachments: boolean;
  messageId: string | null;
  externalContent: true;
  truncated: boolean;
}

export interface EmailView {
  id: string;
  account?: string;
  mailbox: string;
  uid: number;
  from: string[];
  replyTo: string[];
  to: string[];
  cc: string[];
  subject: string;
  date: Date;
  text: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  attachments: AttachmentMeta[];
  unread: boolean;
  externalContent: true;
  truncated: boolean;
  html?: string;
}

const MAX_TOOL_BODY_CHARS = 100_000;

function truncateForTool(value: string, max = MAX_TOOL_BODY_CHARS): { value: string; truncated: boolean } {
  if (value.length <= max) return { value, truncated: false };
  return { value: value.slice(0, max) + '…', truncated: true };
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function preview(value: string, max = 280): string {
  const compact = compactWhitespace(value);
  return compact.length <= max ? compact : compact.slice(0, max - 1) + '…';
}

export function sanitizeHtmlForTool(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<(iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript\s*:/gi, '');
}

export function toSearchSummary(message: NormalizedMessage): SearchEmailSummary {
  return {
    id: message.id,
    account: message.account,
    mailbox: message.mailbox,
    from: message.from,
    to: message.to,
    subject: message.subject,
    date: message.date,
    unread: message.unread ?? false,
    preview: preview(message.text),
    hasAttachments: message.attachments.length > 0,
    messageId: message.messageId,
    externalContent: true,
    truncated: message.truncated ?? false
  };
}

export function toEmailView(message: NormalizedMessage, includeHtml = false): EmailView {
  const text = truncateForTool(message.text);
  let html: { value: string; truncated: boolean } | undefined;
  if (includeHtml && message.html) html = truncateForTool(sanitizeHtmlForTool(message.html));

  const view: EmailView = {
    id: message.id,
    account: message.account,
    mailbox: message.mailbox,
    uid: message.uid,
    from: message.from,
    replyTo: message.replyTo ?? [],
    to: message.to,
    cc: message.cc,
    subject: message.subject,
    date: message.date,
    text: text.value,
    messageId: message.messageId,
    inReplyTo: message.inReplyTo,
    references: message.references,
    attachments: message.attachments,
    unread: message.unread ?? false,
    externalContent: true,
    truncated: Boolean(message.truncated || text.truncated || html?.truncated)
  };

  if (html) view.html = html.value;
  return view;
}
