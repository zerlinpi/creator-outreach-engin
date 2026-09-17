import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

const baseEnv = {
  MAIL_USERNAME: 'campx@example.com',
  MAIL_APP_PASSWORD: 'app-password',
  CONNECTOR_AUTH_TOKEN: 'test-token-1234567890-abcdef-xyz'
};

describe('loadConfig', () => {
  it('requires mailbox credentials and connector token', () => {
    expect(() => loadConfig({})).toThrow();
  });

  it('rejects connector tokens shorter than 32 characters', () => {
    expect(() => loadConfig({ ...baseEnv, CONNECTOR_AUTH_TOKEN: 'too-short-token' })).toThrow();
  });

  it('uses secure Alibaba Mail and bounded resource defaults', () => {
    const config = loadConfig(baseEnv);
    expect(config.imap).toMatchObject({
      host: 'imap.qiye.aliyun.com',
      port: 993,
      secure: true,
      connectionTimeout: 15_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000
    });
    expect(config.smtp).toMatchObject({
      host: 'smtp.qiye.aliyun.com',
      port: 465,
      secure: true,
      connectionTimeout: 15_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000
    });
    expect(config.maxMessageBytes).toBe(10 * 1024 * 1024);
    expect(config.searchSourceBytes).toBe(128 * 1024);
    expect(config.fromName).toBe('CAMPX');
    expect(config.jsonLimit).toBe('1mb');
  });

  it('parses a deployment host allowlist', () => {
    const config = loadConfig({ ...baseEnv, CONNECTOR_ALLOWED_HOSTS: 'mail.campxusainc.com, localhost ,127.0.0.1' });
    expect(config.allowedHosts).toEqual(['mail.campxusainc.com', 'localhost', '127.0.0.1']);
  });

  it('requires a host allowlist in production', () => {
    expect(() => loadConfig({ ...baseEnv, NODE_ENV: 'production' })).toThrow();
    expect(() => loadConfig({
      ...baseEnv,
      NODE_ENV: 'production',
      CONNECTOR_ALLOWED_HOSTS: 'mail.campxusainc.com'
    })).not.toThrow();
  });

  it('rejects a search source cap larger than the full-message cap', () => {
    expect(() => loadConfig({
      ...baseEnv,
      MAIL_MAX_MESSAGE_BYTES: '65536',
      MAIL_SEARCH_SOURCE_BYTES: '131072'
    })).toThrow();
  });

  it('rejects invalid numeric ports and timeout values', () => {
    expect(() => loadConfig({ ...baseEnv, MAIL_IMAP_PORT: 'nope' })).toThrow();
    expect(() => loadConfig({ ...baseEnv, MAIL_SMTP_PORT: '70000' })).toThrow();
    expect(() => loadConfig({ ...baseEnv, MAIL_CONNECTION_TIMEOUT_MS: '0' })).toThrow();
    expect(() => loadConfig({ ...baseEnv, MAIL_SOCKET_TIMEOUT_MS: '9999999' })).toThrow();
  });
});
