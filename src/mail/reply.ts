import { normalizeAddress, validateAddressList } from './addresses.ts';
import { buildReplyHeaders } from './threading.ts';
import type { NormalizedMessage, OutgoingMessage } from './types.ts';

export interface ReplyInput {
  text: string;
  html?: string;
  replyAll?: boolean;
}

export function buildReplyMessage(parent: NormalizedMessage, input: ReplyInput, mailboxAddress: string): OutgoingMessage {
  if (!parent.from?.address) throw new Error('Cannot reply to a message without a sender');

  const mailbox = normalizeAddress(mailboxAddress);
  const sender = normalizeAddress(parent.from.address);
  const headers = buildReplyHeaders(parent);

  const reply: OutgoingMessage = {
    to: [sender],
    subject: headers.subject,
    text: input.text,
    html: input.html,
    inReplyTo: headers.inReplyTo,
    references: headers.references,
  };

  if (input.replyAll) {
    const others = validateAddressList(
      [...parent.to, ...parent.cc]
        .map((entry) => entry.address)
        .filter((address) => normalizeAddress(address) !== mailbox && normalizeAddress(address) !== sender),
      { allowEmpty: true },
    );
    if (others.length > 0) reply.cc = others;
  }

  return reply;
}
