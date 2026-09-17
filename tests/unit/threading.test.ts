import { describe, expect, it } from 'vitest';
import { buildReplyHeaders, normalizeSubject, resolveThread } from '../../src/mail/threading.js';
import type { NormalizedMessage } from '../../src/mail/types.js';

const base = (overrides: Partial<NormalizedMessage>): NormalizedMessage => ({
  id: 'x',
  mailbox: 'INBOX',
  uid: 1,
  from: ['a@example.com'],
  to: ['b@example.com'],
  cc: [],
  subject: 'Topic',
  date: new Date('2026-01-01'),
  text: '',
  html: null,
  messageId: null,
  inReplyTo: null,
  references: [],
  attachments: [],
  ...overrides
});

describe('threading', () => {
  it('normalizes repeated reply prefixes', () => expect(normalizeSubject('Re: RE:  Hello')).toBe('Hello'));
  it('builds deduplicated reply headers', () => expect(buildReplyHeaders({ messageId: '<m2@test>', references: ['<m1@test>', '<m2@test>'] })).toEqual({ inReplyTo: '<m2@test>', references: ['<m1@test>', '<m2@test>'] }));

  it('resolves exact reference chains before heuristic messages', () => {
    const messages = [
      base({ id: '1', messageId: '<1@test>' }),
      base({ id: '2', uid: 2, messageId: '<2@test>', inReplyTo: '<1@test>', references: ['<1@test>'], date: new Date('2026-01-02') }),
      base({ id: '3', uid: 3, subject: 'Other', date: new Date('2026-01-03') })
    ];
    const result = resolveThread(messages, messages[1]);
    expect(result.heuristic).toBe(false);
    expect(result.messages.map((m) => m.id)).toEqual(['1', '2']);
  });

  it('falls back to subject and participants when RFC thread headers connect only the anchor to itself', () => {
    const messages = [
      base({ id: '1', messageId: '<1@test>', date: new Date('2026-01-01') }),
      base({ id: '2', uid: 2, messageId: '<2@test>', subject: 'Re: Topic', date: new Date('2026-01-02') })
    ];

    const result = resolveThread(messages, messages[1]);
    expect(result.heuristic).toBe(true);
    expect(result.messages.map((m) => m.id)).toEqual(['1', '2']);
  });
});
