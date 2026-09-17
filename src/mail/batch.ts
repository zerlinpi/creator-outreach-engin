import { ConnectorError, toSafeError } from '../errors.ts';
import { validateAddressList } from './addresses.ts';
import type { OutgoingMessage, SendResult } from './types.ts';

const DEFAULT_MAX = 10;
const HARD_MAX = 25;

export interface BatchOptions {
  maxMessages?: number;
  allowDuplicates?: boolean;
}

export interface BatchItemResult {
  index: number;
  ok: boolean;
  result?: SendResult;
  error?: ReturnType<typeof toSafeError>;
}

export function validateBatch(messages: OutgoingMessage[], options: BatchOptions = {}): OutgoingMessage[] {
  const requestedMax = options.maxMessages ?? DEFAULT_MAX;
  const max = Math.min(requestedMax, HARD_MAX);
  if (messages.length === 0) throw new ConnectorError('INVALID_ADDRESS', 'Batch must contain at least one message');
  if (messages.length > max) throw new ConnectorError('RATE_LIMITED', `Batch cannot contain more than ${max} messages`);
  if (messages.length > HARD_MAX) throw new ConnectorError('RATE_LIMITED', `Batch cannot contain more than ${HARD_MAX} messages`);

  const seen = new Set<string>();
  return messages.map((message) => {
    const to = validateAddressList(message.to);
    const cc = message.cc ? validateAddressList(message.cc, { allowEmpty: true }) : undefined;
    const bcc = message.bcc ? validateAddressList(message.bcc, { allowEmpty: true }) : undefined;
    const key = `${[...to].sort().join(',')}|${message.subject.trim().toLowerCase()}`;
    if (!options.allowDuplicates && seen.has(key)) {
      throw new ConnectorError('RATE_LIMITED', `Duplicate recipient and subject combination: ${key}`);
    }
    seen.add(key);
    return { ...message, to, cc, bcc };
  });
}

export async function executeBatch(
  messages: OutgoingMessage[],
  send: (message: OutgoingMessage) => Promise<SendResult>,
  options: BatchOptions = {},
): Promise<BatchItemResult[]> {
  const validated = validateBatch(messages, options);
  const results: BatchItemResult[] = [];

  for (let index = 0; index < validated.length; index += 1) {
    const message = validated[index];
    try {
      let result: SendResult;
      try {
        result = await send(message);
      } catch (error) {
        if (error instanceof ConnectorError && error.code === 'TRANSIENT_MAIL_ERROR') {
          result = await send(message);
        } else {
          throw error;
        }
      }
      results.push({ index, ok: true, result });
    } catch (error) {
      results.push({ index, ok: false, error: toSafeError(error) });
    }
  }

  return results;
}
