import { describe, expect, it } from 'vitest';
import { toEmailView, toSearchSummary } from '../../src/mail/presenters.js';
import type { NormalizedMessage } from '../../src/mail/types.js';

const message: NormalizedMessage = {
  id: 'ref-1',
  mailbox: 'INBOX',
  uid: 10,
  from: ['creator@example.com'],
  replyTo: ['partnerships@agency.example'],
  to: ['campx@example.com'],
  cc: [],
  subject: 'CAMPX partnership',
  date: new Date('2026-09-17T12:00:00Z'),
  text: 'Hello CAMPX,\n\nI am interested in working together. '.repeat(20),
  html: '<p onclick="evil()">Hello</p><script>alert(1)</script><a href="javascript:evil()">link</a>',
  messageId: '<m1@example.com>',
  inReplyTo: null,
  references: [],
  attachments: [{ filename: 'rate.pdf', contentType: 'application/pdf', size: 100, contentDisposition: 'attachment', cid: null }],
  unread: true,
  truncated: true
};

describe('mail tool presenters', () => {
  it('returns compact search summaries without full body or HTML and exposes truncation', () => {
    const summary = toSearchSummary(message);
    expect(summary).toMatchObject({
      id: 'ref-1',
      subject: 'CAMPX partnership',
      externalContent: true,
      hasAttachments: true,
      truncated: true
    });
    expect(summary.preview.length).toBeLessThanOrEqual(280);
    expect(summary).not.toHaveProperty('html');
    expect(summary).not.toHaveProperty('text');
  });

  it('bounds full email body content returned to MCP clients', () => {
    const oversized: NormalizedMessage = {
      ...message,
      text: 'x'.repeat(120_000),
      html: '<p>' + 'y'.repeat(120_000) + '</p>',
      truncated: false
    };
    const view = toEmailView(oversized, true);
    expect(view.text.length).toBeLessThanOrEqual(100_001);
    expect(view.html!.length).toBeLessThanOrEqual(100_001);
    expect(view.truncated).toBe(true);
  });

  it('exposes reply routing, truncation, omits HTML by default, and sanitizes HTML when explicitly requested', () => {
    const plain = toEmailView(message, false);
    expect(plain.replyTo).toEqual(['partnerships@agency.example']);
    expect(plain).not.toHaveProperty('html');
    expect(plain.externalContent).toBe(true);
    expect(plain.truncated).toBe(true);

    const withHtml = toEmailView(message, true);
    expect(withHtml.replyTo).toEqual(['partnerships@agency.example']);
    expect(withHtml.html).toContain('<p>Hello</p>');
    expect(withHtml.html).not.toContain('<script');
    expect(withHtml.html).not.toContain('onclick=');
    expect(withHtml.html).not.toContain('javascript:');
  });
});
