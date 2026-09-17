import { describe, expect, it } from 'vitest';
import { executeBatch, validateBatch } from '../../src/mail/batch.js';
import { ConnectorError } from '../../src/errors.js';

const msg = (to: string, subject = 'Hello') => ({ to: [to], subject, text: 'Body' });

describe('batch safety', () => {
  it('defaults to a maximum of 10 messages', () => expect(() => validateBatch(Array.from({ length: 11 }, (_, i) => msg(`u${i}@example.com`)))).toThrow());
  it('never permits more than 25 messages', () => expect(() => validateBatch(Array.from({ length: 26 }, (_, i) => msg(`u${i}@example.com`)), { max: 25 })).toThrow());
  it('rejects duplicate recipient and subject pairs', () => expect(() => validateBatch([msg('a@example.com'), msg('A@example.com')])).toThrow());

  it('treats empty optional cc and bcc lists as omitted', () => {
    const [validated] = validateBatch([{ ...msg('a@example.com'), cc: [], bcc: [] }]);
    expect(validated.cc).toBeUndefined();
    expect(validated.bcc).toBeUndefined();
  });

  it('returns independent item results with recipient and subject identity', async () => {
    const result = await executeBatch(
      [msg('a@example.com', 'A'), msg('b@example.com', 'B')],
      async (message) => ({ accepted: message.to, rejected: [], messageId: `<${message.to[0]}>` }),
      { delayMs: 0 }
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ ok: true, index: 0, to: ['a@example.com'], subject: 'A' });
    expect(result[1]).toMatchObject({ ok: true, index: 1, to: ['b@example.com'], subject: 'B' });
  });

  it('retries one transient failure and then succeeds', async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const result = await executeBatch(
      [msg('a@example.com')],
      async (message) => {
        attempts += 1;
        if (attempts === 1) throw new ConnectorError('TRANSIENT_MAIL_ERROR', 'Temporary network issue.');
        return { accepted: message.to, rejected: [], messageId: '<ok@example.com>' };
      },
      { retryTransient: true, retryDelayMs: 750, delayMs: 0, sleep: async (ms) => { sleeps.push(ms); } }
    );
    expect(attempts).toBe(2);
    expect(sleeps).toEqual([750]);
    expect(result[0]).toMatchObject({ ok: true, to: ['a@example.com'] });
  });

  it('does not retry permanent failures', async () => {
    let attempts = 0;
    const result = await executeBatch(
      [msg('a@example.com')],
      async () => {
        attempts += 1;
        throw new ConnectorError('RECIPIENT_REJECTED', 'Permanent failure.');
      },
      { retryTransient: true, delayMs: 0, sleep: async () => undefined }
    );
    expect(attempts).toBe(1);
    expect(result[0]).toMatchObject({ ok: false, to: ['a@example.com'] });
  });

  it('throttles between separate creator messages', async () => {
    const sleeps: number[] = [];
    await executeBatch(
      [msg('a@example.com'), msg('b@example.com'), msg('c@example.com')],
      async (message) => ({ accepted: message.to, rejected: [], messageId: `<${message.to[0]}>` }),
      { delayMs: 250, sleep: async (ms) => { sleeps.push(ms); } }
    );
    expect(sleeps).toEqual([250, 250]);
  });
});
