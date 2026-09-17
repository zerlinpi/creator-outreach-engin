import type { NormalizedMessage, OutgoingMessage } from './types.js';
import { buildReplyHeaders, normalizeSubject } from './threading.js';
import { normalizeAddress, validateAddressList } from './addresses.js';

export interface ReplyInput { text: string; html?: string; replyAll?: boolean }

export function buildReplyMessage(parent: NormalizedMessage, input: ReplyInput, mailboxAddress: string): OutgoingMessage {
  const self = normalizeAddress(mailboxAddress);
  const externalSenders = parent.from.map(normalizeAddress).filter((address) => address !== self);
  const explicitReplyTargets = (parent.replyTo ?? []).map(normalizeAddress).filter((address) => address !== self);
  const originalRecipients = parent.to.map(normalizeAddress).filter((address) => address !== self);

  const replyTargets = externalSenders.length && explicitReplyTargets.length
    ? explicitReplyTargets
    : externalSenders;
  const to = validateAddressList(replyTargets.length ? replyTargets : originalRecipients);

  const cc = input.replyAll
    ? [...new Set(
        [...parent.to, ...parent.cc]
          .map(normalizeAddress)
          .filter((address) => address !== self && !to.includes(address))
      )]
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
