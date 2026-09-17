import { ConnectorError, toSafeError } from '../errors.js';
import { validateAddressList } from './addresses.js';
import type { OutgoingMessage, SendResult } from './types.js';

export interface BatchOptions {
  max?: number;
  allowDuplicates?: boolean;
  delayMs?: number;
  retryTransient?: boolean;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export type BatchItemResult =
  | {
      ok: true;
      index: number;
      to: string[];
      subject: string;
      attempts: number;
      result: SendResult;
    }
  | {
      ok: false;
      index: number;
      to: string[];
      subject: string;
      attempts: number;
      error: ReturnType<typeof toSafeError>;
    };

export interface BatchPreflightItem {
  index: number;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  dryRun: true;
}

const DEFAULT_DELAY_MS = 250;
const DEFAULT_RETRY_DELAY_MS = 1000;

function optionalAddresses(values?: string[]): string[] | undefined {
  return values?.length ? validateAddressList(values) : undefined;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransient(error: unknown): boolean {
  return error instanceof ConnectorError &&
    (error.code === 'TRANSIENT_MAIL_ERROR' || error.code === 'RATE_LIMITED');
}

function validateTiming(options: BatchOptions): { delayMs: number; retryDelayMs: number } {
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 5000) {
    throw new ConnectorError('RATE_LIMITED', 'Batch delay must be between 0 and 5000 milliseconds.');
  }
  if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 10000) {
    throw new ConnectorError('RATE_LIMITED', 'Retry delay must be between 0 and 10000 milliseconds.');
  }

  return { delayMs, retryDelayMs };
}

export function validateBatch(messages: OutgoingMessage[], options: BatchOptions = {}): OutgoingMessage[] {
  const max = options.max ?? 10;
  if (max < 1 || max > 25) {
    throw new ConnectorError('RATE_LIMITED', 'Batch maximum must be between 1 and 25.');
  }
  if (messages.length > max || messages.length > 25) {
    throw new ConnectorError('RATE_LIMITED', `Batch contains too many messages (max ${Math.min(max, 25)}).`);
  }

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

export function preflightBatch(messages: OutgoingMessage[], options: BatchOptions = {}): BatchPreflightItem[] {
  return validateBatch(messages, options).map((message, index) => ({
    index,
    to: message.to,
    cc: message.cc ?? [],
    bcc: message.bcc ?? [],
    subject: message.subject,
    dryRun: true
  }));
}

export async function executeBatch(
  messages: OutgoingMessage[],
  send: (message: OutgoingMessage) => Promise<SendResult>,
  options: BatchOptions = {}
): Promise<BatchItemResult[]> {
  const validated = validateBatch(messages, options);
  const { delayMs, retryDelayMs } = validateTiming(options);
  const retryTransient = options.retryTransient ?? true;
  const sleep = options.sleep ?? defaultSleep;
  const results: BatchItemResult[] = [];

  for (let index = 0; index < validated.length; index += 1) {
    const message = validated[index];
    let attempts = 0;

    try {
      attempts += 1;
      const sent = await send(message);
      results.push({
        ok: true,
        index,
        to: message.to,
        subject: message.subject,
        attempts,
        result: sent
      });
    } catch (firstError) {
      if (retryTransient && isTransient(firstError)) {
        try {
          if (retryDelayMs > 0) await sleep(retryDelayMs);
          attempts += 1;
          const sent = await send(message);
          results.push({
            ok: true,
            index,
            to: message.to,
            subject: message.subject,
            attempts,
            result: sent
          });
        } catch (retryError) {
          results.push({
            ok: false,
            index,
            to: message.to,
            subject: message.subject,
            attempts,
            error: toSafeError(retryError)
          });
        }
      } else {
        results.push({
          ok: false,
          index,
          to: message.to,
          subject: message.subject,
          attempts,
          error: toSafeError(firstError)
        });
      }
    }

    if (index < validated.length - 1 && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  return results;
}
