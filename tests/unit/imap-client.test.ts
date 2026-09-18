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
