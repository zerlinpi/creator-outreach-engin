import { describe, expect, it } from 'vitest';
import { ConnectorError } from '../../src/errors.js';
import { executeBatch } from '../../src/mail/batch.js';
import type { OutgoingMessage, SendResult } from '../../src/mail/types.js';

function makeMessages(count: number): OutgoingMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    to: [`creator${index}@example.com`],
    subject: `CAMPX limit test ${index}`,
    text: `Hello ${index}`
  }));
}

function successFor(message: OutgoingMessage): SendResult {
  return {
    accepted: message.to,
    rejected: [],
    messageId: `<${message.subject.replace(/\s+/g, '-')}@example.com>`
  };
}

describe('batch execution limits', () => {
  it('executes the maximum 25-message batch sequentially with SMTP concurrency capped at one', async () => {
    let active = 0;
    let maxActive = 0;
    let sends = 0;

    const results = await executeBatch(makeMessages(25), async (message) => {
      sends += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active -= 1;
      return successFor(message);
    }, { max: 25, delayMs: 0 });

    expect(results).toHaveLength(25);
    expect(results.every((item) => item.ok && item.attempts === 1)).toBe(true);
    expect(sends).toBe(25);
    expect(maxActive).toBe(1);
  });

  it('never exceeds 50 SMTP attempts when all 25 messages receive one explicit transient retry', async () => {
    let attempts = 0;
    const results = await executeBatch(makeMessages(25), async () => {
      attempts += 1;
      throw new ConnectorError('TRANSIENT_MAIL_ERROR', 'temporary');
    }, {
      max: 25,
      delayMs: 0,
      retryTransient: true,
      retryDelayMs: 0
    });

    expect(attempts).toBe(50);
    expect(results).toHaveLength(25);
    expect(results.every((item) => !item.ok && item.attempts === 2)).toBe(true);
  });

  it('rejects 26 messages before invoking the sender', async () => {
    let sends = 0;
    await expect(executeBatch(makeMessages(26), async (message) => {
      sends += 1;
      return successFor(message);
    }, { max: 25, delayMs: 0 })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(sends).toBe(0);
  });

  it('isolates mixed permanent and transient failures across all 25 inputs without aborting later creators', async () => {
    const attempts = new Map<number, number>();
    let totalAttempts = 0;

    const results = await executeBatch(makeMessages(25), async (message) => {
      totalAttempts += 1;
      const index = Number(message.to[0].match(/creator(\d+)@/)?.[1]);
      const count = (attempts.get(index) ?? 0) + 1;
      attempts.set(index, count);

      if (index % 5 === 0) {
        throw new ConnectorError('RECIPIENT_REJECTED', 'permanent');
      }
      if (index % 5 === 1 && count === 1) {
        throw new ConnectorError('TRANSIENT_MAIL_ERROR', 'temporary');
      }
      return successFor(message);
    }, {
      max: 25,
      delayMs: 0,
      retryTransient: true,
      retryDelayMs: 0
    });

    expect(results.map((item) => item.index)).toEqual(Array.from({ length: 25 }, (_, index) => index));
    expect(results.filter((item) => item.ok)).toHaveLength(20);
    expect(results.filter((item) => !item.ok)).toHaveLength(5);
    expect(totalAttempts).toBe(30);
    expect(attempts.get(24)).toBe(1);
  });

  it('rejects configured wait time above 60 seconds before the first send', async () => {
    let sends = 0;
    await expect(executeBatch(makeMessages(25), async (message) => {
      sends += 1;
      return successFor(message);
    }, {
      max: 25,
      delayMs: 2501,
      retryTransient: false
    })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(sends).toBe(0);
  });
});
