import { ConnectorError } from '../errors.ts';
import type { OutgoingMessage } from '../mail/types.ts';

export interface OutgoingToolInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  html?: string;
  reply_to?: string;
}

export function mapOutgoingInput(input: OutgoingToolInput): OutgoingMessage {
  const { reply_to, ...rest } = input;
  return { ...rest, ...(reply_to ? { replyTo: reply_to } : {}) };
}

export interface ThreadLookupToolInput {
  message_id?: string;
  participant?: string;
  subject?: string;
  limit?: number;
}

export function validateThreadLookupInput(input: ThreadLookupToolInput): ThreadLookupToolInput {
  if (!input.message_id && !input.participant) {
    throw new ConnectorError('THREAD_NOT_FOUND', 'message_id or participant is required');
  }
  return input;
}
