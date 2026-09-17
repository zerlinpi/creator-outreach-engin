import { ConnectorError, toSafeError } from '../errors.js';
import { validateAddressList } from './addresses.js';
import type { OutgoingMessage, SendResult } from './types.js';

function optionalAddresses(values?: string[]): string[] | undefined {
  return values?.length ? validateAddressList(values) : undefined;
}

export function validateBatch(messages: OutgoingMessage[], options: { max?: number; allowDuplicates?: boolean } = {}): OutgoingMessage[] {
  const max = options.max ?? 10;
  if (max < 1 || max > 25) throw new ConnectorError('RATE_LIMITED', 'Batch maximum must be between 1 and 25.');
  if (messages.length > max || messages.length > 25) throw new ConnectorError('RATE_LIMITED', `Batch contains too many messages (max ${Math.min(max, 25)}).`);

  const seen = new Set<string>();
  return messages.map((message) => {
    const normalized = {
      ...message,
      to: validateAddressList(message.to),
      cc: optionalAddresses(message.cc),
      bcc: optionalAddresses(message.bcc)
    };
    const key = `${normalized.to.join(',')}|${normalized.subject.trim().toLowerCase()}`;
    if (!options.allowDuplicates && seen.has(key)) {
      throw new ConnectorError('RECIPIENT_REJECTED', 'Duplicate recipient and subject in the same batch.');
    }
    seen.add(key);
    return normalized;
  });
}

export async function executeBatch(
  messages: OutgoingMessage[],
  send: (message: OutgoingMessage) => Promise<SendResult>,
  options: { max?: number; allowDuplicates?: boolean } = {}
) {
  const validated = validateBatch(messages, options);
  const results: Array<{ ok: true; result: SendResult } | { ok: false; error: ReturnType<typeof toSafeError> }> = [];
  for (const message of validated) {
    try {
      results.push({ ok: true, result: await send(message) });
    } catch (error) {
      results.push({ ok: false, error: toSafeError(error) });
    }
  }
  return results;
}
