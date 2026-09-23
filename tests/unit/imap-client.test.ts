import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../src/config.js';
import {
  attachImapErrorListener,
  buildFullMessageFetchQuery,
  buildImapClientOptions,
  buildSearchFetchQuery,
  decodeMessageRef,
  encodeMessageRef,
  enforceMessageSize
} from '../../src/mail/imap-client.js';
import { ConnectorError } from '../../src/errors.js';

const config: AppConfig = {
  username: 'campx@example.com',
  appPassword: 'app-password',
  fromName: 'CAMPX',
  authToken: '1234567890abcdef1234567890abcdef',
  jsonLimit: '1mb',
  port: 3000,
  maxMessageBytes: 10 * 1024 * 1024,
  searchSourceBytes: 128 * 1024,
  imap: {
    host: 'imap.qiye.aliyun.com',
    port: 993,
    secure: true,
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000
  },
  smtp: {
    host: 'smtp.qiye.aliyun.com',
    port: 465,
    secure: true,
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000
  }
};

describe('stable IMAP message references', () => {
  it('round-trips mailbox, UID, and UIDVALIDITY without exposing mailbox names', () => {
    const ref = encodeMessageRef('INBOX/Creators', 1234, 987654321n);
    expect(ref).not.toContain('INBOX/Creators');
    expect(decodeMessageRef(ref)).toEqual({ mailbox: 'INBOX/Creators', uid: 1234, uidValidity: '987654321' });
  });

  it('binds new references to a mail account without exposing the account in plain text', () => {
    const ref = encodeMessageRef('INBOX', 7, 11, 'hassky');
    expect(ref).not.toContain('hassky');
    expect(decodeMessageRef(ref)).toEqual({
      account: 'hassky',
      mailbox: 'INBOX',
      uid: 7,
      uidValidity: '11'
    });
  });

  it('signs production message references and rejects tampering', () => {
    const secret = 'signed-message-ref-secret-1234567890';
    const ref = encodeMessageRef('INBOX', 7, 11, 'hassky', secret);
    expect(ref).toMatch(/^mr1\./);
    expect(decodeMessageRef(ref, secret)).toEqual({
      account: 'hassky',
      mailbox: 'INBOX',
      uid: 7,
      uidValidity: '11'
    });

    const parts = ref.split('.');
    const tamperedBody = Buffer.from(JSON.stringify({
      account: 'campx',
      mailbox: 'INBOX',
      uid: 7,
      uidValidity: '11'
    }), 'utf8').toString('base64url');
    expect(() => decodeMessageRef([parts[0], tamperedBody, parts[2]].join('.'), secret))
      .toThrowError(expect.objectContaining({ code: 'MESSAGE_NOT_FOUND' }));
  });

  it('allows unsigned legacy refs only when explicitly opted into migration mode', () => {
    const ref = encodeMessageRef('INBOX', 7, 11, 'hassky');
    const secret = 'signed-message-ref-secret-1234567890';
    expect(() => decodeMessageRef(ref, secret)).toThrowError(expect.objectContaining({ code: 'MESSAGE_NOT_FOUND' }));
    expect(decodeMessageRef(ref, secret, true)).toEqual({
      account: 'hassky',
      mailbox: 'INBOX',
      uid: 7,
      uidValidity: '11'
    });
  });

  it('rejects control characters in message-reference mailbox names', () => {
    const unsafe = Buffer.from(JSON.stringify({ mailbox: 'INBOX\r\nBAD', uid: 1, uidValidity: '1' }), 'utf8').toString('base64url');
    expect(() => decodeMessageRef(unsafe)).toThrowError(expect.objectContaining({ code: 'MESSAGE_NOT_FOUND' }));
  });

  it('rejects legacy or malformed references that are not bound to UIDVALIDITY', () => {
    const legacy = Buffer.from(JSON.stringify({ mailbox: 'INBOX', uid: 1 }), 'utf8').toString('base64url');
    expect(() => decodeMessageRef(legacy)).toThrowError(ConnectorError);
    expect(() => decodeMessageRef('not-a-valid-ref')).toThrowError(ConnectorError);

    for (const ref of [legacy, 'not-a-valid-ref']) {
      try { decodeMessageRef(ref); } catch (error) {
        expect((error as ConnectorError).code).toBe('MESSAGE_NOT_FOUND');
      }
    }
  });
});

describe('IMAP resource policy', () => {
  it('builds implicit TLS options with bounded connection timeouts and disabled logs', () => {
    expect(buildImapClientOptions(config)).toEqual({
      host: 'imap.qiye.aliyun.com',
      port: 993,
      secure: true,
      auth: { user: 'campx@example.com', pass: 'app-password' },
      logger: false,
      connectionTimeout: 15_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000
    });
  });

  it('requests only the configured source window for search results and asks for full size metadata', () => {
    expect(buildSearchFetchQuery(config)).toEqual({
      uid: true,
      source: { start: 0, maxLength: 128 * 1024 },
      size: true,
      flags: true
    });
  });

  it('bounds full-message retrieval to one byte beyond the configured cap so oversize messages can be rejected', () => {
    expect(buildFullMessageFetchQuery(config)).toEqual({
      uid: true,
      source: { start: 0, maxLength: 10 * 1024 * 1024 + 1 },
      size: true,
      flags: true
    });
  });

  it('rejects a full message that exceeds the configured byte cap', () => {
    expect(() => enforceMessageSize(10 * 1024 * 1024, config.maxMessageBytes)).not.toThrow();
    expect(() => enforceMessageSize(10 * 1024 * 1024 + 1, config.maxMessageBytes)).toThrowError(ConnectorError);
    try { enforceMessageSize(10 * 1024 * 1024 + 1, config.maxMessageBytes); } catch (error) {
      expect((error as ConnectorError).code).toBe('MESSAGE_TOO_LARGE');
    }
  });
});

describe('IMAP error event safety', () => {
  it('consumes emitted error events so transport timeouts do not crash the Node process', () => {
    const emitter = new EventEmitter();
    attachImapErrorListener(emitter);
    expect(() => emitter.emit('error', Object.assign(new Error('Socket timeout'), { code: 'ETIMEOUT' }))).not.toThrow();
  });
});
