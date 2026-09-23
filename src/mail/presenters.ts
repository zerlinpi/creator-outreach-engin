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
const MAX_TOOL_HEADER_CHARS = 1_000;
const MAX_TOOL_ADDRESS_CHARS = 320;
const MAX_TOOL_ADDRESS_COUNT = 100;
const MAX_TOOL_REFERENCE_COUNT = 100;
const MAX_TOOL_ATTACHMENT_COUNT = 100;
const MAX_TOOL_ATTACHMENT_FIELD_CHARS = 512;

function truncateForTool(value: string, max = MAX_TOOL_BODY_CHARS): { value: string; truncated: boolean } {
  if (value.length <= max) return { value, truncated: false };
  return { value: value.slice(0, max) + '…', truncated: true };
}

function truncateNullable(value: string | null, max: number): { value: string | null; truncated: boolean } {
  if (value === null) return { value: null, truncated: false };
  const clipped = truncateForTool(value, max);
  return { value: clipped.value, truncated: clipped.truncated };
}

function truncateList(values: string[], maxItems: number, maxChars: number): { values: string[]; truncated: boolean } {
  let truncated = values.length > maxItems;
  const clipped = values.slice(0, maxItems).map((value) => {
    const item = truncateForTool(value, maxChars);
    truncated ||= item.truncated;
    return item.value;
  });
  return { values: clipped, truncated };
}

function truncateAttachments(values: AttachmentMeta[]): { values: AttachmentMeta[]; truncated: boolean } {
  let truncated = values.length > MAX_TOOL_ATTACHMENT_COUNT;
  const clipped = values.slice(0, MAX_TOOL_ATTACHMENT_COUNT).map((attachment) => {
    const filename = truncateNullable(attachment.filename, MAX_TOOL_ATTACHMENT_FIELD_CHARS);
    const contentType = truncateForTool(attachment.contentType, MAX_TOOL_ATTACHMENT_FIELD_CHARS);
    const contentDisposition = truncateNullable(attachment.contentDisposition, MAX_TOOL_ATTACHMENT_FIELD_CHARS);
    const cid = truncateNullable(attachment.cid, MAX_TOOL_ATTACHMENT_FIELD_CHARS);
    truncated ||= filename.truncated || contentType.truncated || contentDisposition.truncated || cid.truncated;
    return {
      filename: filename.value,
      contentType: contentType.value,
      size: attachment.size,
      contentDisposition: contentDisposition.value,
      cid: cid.value
    };
  });
  return { values: clipped, truncated };
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
  const mailbox = truncateForTool(message.mailbox, MAX_TOOL_HEADER_CHARS);
  const from = truncateList(message.from, MAX_TOOL_ADDRESS_COUNT, MAX_TOOL_ADDRESS_CHARS);
  const to = truncateList(message.to, MAX_TOOL_ADDRESS_COUNT, MAX_TOOL_ADDRESS_CHARS);
  const subject = truncateForTool(message.subject, MAX_TOOL_HEADER_CHARS);
  const messageId = truncateNullable(message.messageId, MAX_TOOL_HEADER_CHARS);
  return {
    id: message.id,
    account: message.account,
    mailbox: mailbox.value,
    from: from.values,
    to: to.values,
    subject: subject.value,
    date: message.date,
    unread: message.unread ?? false,
    preview: preview(message.text),
    hasAttachments: message.attachments.length > 0,
    messageId: messageId.value,
    externalContent: true,
    truncated: Boolean(message.truncated || mailbox.truncated || from.truncated || to.truncated || subject.truncated || messageId.truncated)
  };
}

export function toEmailView(message: NormalizedMessage, includeHtml = false): EmailView {
  const text = truncateForTool(message.text);
  const mailbox = truncateForTool(message.mailbox, MAX_TOOL_HEADER_CHARS);
  const from = truncateList(message.from, MAX_TOOL_ADDRESS_COUNT, MAX_TOOL_ADDRESS_CHARS);
  const replyTo = truncateList(message.replyTo ?? [], MAX_TOOL_ADDRESS_COUNT, MAX_TOOL_ADDRESS_CHARS);
  const to = truncateList(message.to, MAX_TOOL_ADDRESS_COUNT, MAX_TOOL_ADDRESS_CHARS);
  const cc = truncateList(message.cc, MAX_TOOL_ADDRESS_COUNT, MAX_TOOL_ADDRESS_CHARS);
  const subject = truncateForTool(message.subject, MAX_TOOL_HEADER_CHARS);
  const messageId = truncateNullable(message.messageId, MAX_TOOL_HEADER_CHARS);
  const inReplyTo = truncateNullable(message.inReplyTo, MAX_TOOL_HEADER_CHARS);
  const references = truncateList(message.references, MAX_TOOL_REFERENCE_COUNT, MAX_TOOL_HEADER_CHARS);
  const attachments = truncateAttachments(message.attachments);
  let html: { value: string; truncated: boolean } | undefined;
  if (includeHtml && message.html) html = truncateForTool(sanitizeHtmlForTool(message.html));

  const view: EmailView = {
    id: message.id,
    account: message.account,
    mailbox: mailbox.value,
    uid: message.uid,
    from: from.values,
    replyTo: replyTo.values,
    to: to.values,
    cc: cc.values,
    subject: subject.value,
    date: message.date,
    text: text.value,
    messageId: messageId.value,
    inReplyTo: inReplyTo.value,
    references: references.values,
    attachments: attachments.values,
    unread: message.unread ?? false,
    externalContent: true,
    truncated: Boolean(
      message.truncated ||
      text.truncated ||
      html?.truncated ||
      mailbox.truncated ||
      from.truncated ||
      replyTo.truncated ||
      to.truncated ||
      cc.truncated ||
      subject.truncated ||
      messageId.truncated ||
      inReplyTo.truncated ||
      references.truncated ||
      attachments.truncated
    )
  };

  if (html) view.html = html.value;
  return view;
}
