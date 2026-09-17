import type { NormalizedMessage, OutgoingMessage } from './types.js';
import { buildReplyHeaders, normalizeSubject } from './threading.js';
import { normalizeAddress, validateAddressList } from './addresses.js';

export interface ReplyInput { text: string; html?: string; replyAll?: boolean }

export function buildReplyMessage(parent: NormalizedMessage, input: ReplyInput, mailboxAddress: string): OutgoingMessage {
  const self = normalizeAddress(mailboxAddress);
  const to = validateAddressList(parent.from.filter((a) => normalizeAddress(a) !== self));
  const cc = input.replyAll
    ? [...new Set([...parent.to, ...parent.cc].map(normalizeAddress).filter((a) => a !== self && !to.includes(a)))]
    : [];
  const headers = buildReplyHeaders(parent);
  return {
    to,
    cc,
    subject: `Re: ${normalizeSubject(parent.subject)}`,
    text: input.text,
    html: input.html,
    inReplyTo: headers.inReplyTo,
    references: headers.references
  };
}
