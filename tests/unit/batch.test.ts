import { describe, expect, it } from 'vitest';
import { executeBatch, validateBatch } from '../../src/mail/batch.js';

const msg = (to: string, subject = 'Hello') => ({ to: [to], subject, text: 'Body' });

describe('batch safety', () => {
  it('defaults to a maximum of 10 messages', () => expect(() => validateBatch(Array.from({ length: 11 }, (_, i) => msg(`u${i}@example.com`)))).toThrow());
  it('never permits more than 25 messages', () => expect(() => validateBatch(Array.from({ length: 26 }, (_, i) => msg(`u${i}@example.com`)), { max: 25 })).toThrow());
  it('rejects duplicate recipient and subject pairs', () => expect(() => validateBatch([msg('a@example.com'), msg('A@example.com')])).toThrow());
  it('returns independent item results', async () => {
    const result = await executeBatch([msg('a@example.com'), msg('b@example.com')], async (message) => ({ accepted: message.to, rejected: [], messageId: `<${message.to[0]}>` }));
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.ok)).toBe(true);
  });
});
