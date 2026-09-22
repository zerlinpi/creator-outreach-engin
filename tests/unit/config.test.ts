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

  it('treats blank optional environment values as unset', () => {
    const config = loadConfig({
      ...baseEnv,
      MAIL_ADMIN_PASSWORD: '',
      MAIL_ACCOUNT_STORE_KEY: '',
      MAIL_MESSAGE_REF_SIGNING_KEY: '',
      MAIL_DEFAULT_ACCOUNT: '',
      CONNECTOR_ALLOWED_HOSTS: '',
      OAUTH_ISSUER: '',
      OAUTH_LOGIN_PASSWORD: '',
      OAUTH_SIGNING_SECRET: ''
    });
    expect(config.mailAdmin).toBeUndefined();
    expect(config.oauth).toBeUndefined();
    expect(config.allowedHosts).toBeUndefined();
    expect(config.defaultAccount).toBe('default');
  });

  it('still rejects partially configured optional feature blocks', () => {
    expect(() => loadConfig({
      ...baseEnv,
      MAIL_ADMIN_PASSWORD: 'admin-password-1234',
      MAIL_ACCOUNT_STORE_KEY: ''
    })).toThrow();
    expect(() => loadConfig({
      ...baseEnv,
      OAUTH_ISSUER: 'https://domail.campxusainc.com',
      OAUTH_LOGIN_PASSWORD: '',
      OAUTH_SIGNING_SECRET: ''
    })).toThrow();
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
    expect(config.defaultAccount).toBe('default');
    expect(Object.keys(config.accounts ?? {})).toEqual(['default']);
    expect(config.jsonLimit).toBe('1mb');
  });

  it('supports named multi-mailbox accounts with isolated credentials and sender identity', () => {
    const config = loadConfig({
      CONNECTOR_AUTH_TOKEN: 'test-token-1234567890-abcdef-xyz',
      MAIL_ACCOUNTS: 'campx,hassky',
      MAIL_DEFAULT_ACCOUNT: 'hassky',
      MAIL_CAMPX_USERNAME: 'campx@example.com',
      MAIL_CAMPX_APP_PASSWORD: 'campx-secret',
      MAIL_CAMPX_FROM_NAME: 'CAMPX',
      MAIL_HASSKY_USERNAME: 'hassky@example.com',
      MAIL_HASSKY_APP_PASSWORD: 'hassky-secret',
      MAIL_HASSKY_FROM_NAME: 'HASSKY Mobility',
      MAIL_HASSKY_IMAP_HOST: 'imap.hassky.example.com',
      MAIL_HASSKY_SMTP_HOST: 'smtp.hassky.example.com'
    });

    expect(config.defaultAccount).toBe('hassky');
    expect(config.username).toBe('hassky@example.com');
    expect(config.fromName).toBe('HASSKY Mobility');
    expect(Object.keys(config.accounts ?? {})).toEqual(['campx', 'hassky']);
    expect(config.accounts?.campx).toMatchObject({
      id: 'campx',
      username: 'campx@example.com',
      fromName: 'CAMPX'
    });
    expect(config.accounts?.hassky).toMatchObject({
      id: 'hassky',
      username: 'hassky@example.com',
      fromName: 'HASSKY Mobility',
      imap: { host: 'imap.hassky.example.com' },
      smtp: { host: 'smtp.hassky.example.com' }
    });
  });

  it('fails closed for incomplete or ambiguous multi-mailbox configuration', () => {
    const shared = {
      CONNECTOR_AUTH_TOKEN: 'test-token-1234567890-abcdef-xyz',
      MAIL_ACCOUNTS: 'campx,hassky',
      MAIL_CAMPX_USERNAME: 'campx@example.com',
      MAIL_CAMPX_APP_PASSWORD: 'campx-secret',
      MAIL_CAMPX_FROM_NAME: 'CAMPX',
      MAIL_HASSKY_USERNAME: 'hassky@example.com',
      MAIL_HASSKY_APP_PASSWORD: 'hassky-secret'
    };
    expect(() => loadConfig(shared)).toThrow();
    expect(() => loadConfig({ ...shared, MAIL_HASSKY_FROM_NAME: 'HASSKY', MAIL_DEFAULT_ACCOUNT: 'missing' })).toThrow();
    expect(() => loadConfig({ ...shared, MAIL_HASSKY_FROM_NAME: 'HASSKY', MAIL_ACCOUNTS: 'campx,campx' })).toThrow();
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

  it('enables OAuth only when all OAuth secrets are configured', () => {
    expect(loadConfig(baseEnv).oauth).toBeUndefined();
    expect(() => loadConfig({ ...baseEnv, OAUTH_ISSUER: 'https://domail.campxusainc.com' })).toThrow();

    const config = loadConfig({
      ...baseEnv,
      NODE_ENV: 'production',
      CONNECTOR_ALLOWED_HOSTS: 'domail.campxusainc.com',
      OAUTH_ISSUER: 'https://domail.campxusainc.com',
      OAUTH_LOGIN_PASSWORD: 'oauth-login-password-123',
      OAUTH_SIGNING_SECRET: 'oauth-signing-secret-1234567890-abcdef'
    });

    expect(config.oauth).toEqual({
      issuer: 'https://domail.campxusainc.com',
      loginPassword: 'oauth-login-password-123',
      signingSecret: 'oauth-signing-secret-1234567890-abcdef'
    });
  });

  it('requires HTTPS and an allowed issuer host for production OAuth', () => {
    const oauth = {
      OAUTH_LOGIN_PASSWORD: 'oauth-login-password-123',
      OAUTH_SIGNING_SECRET: 'oauth-signing-secret-1234567890-abcdef'
    };
    expect(() => loadConfig({
      ...baseEnv,
      ...oauth,
      NODE_ENV: 'production',
      CONNECTOR_ALLOWED_HOSTS: 'domail.campxusainc.com',
      OAUTH_ISSUER: 'http://domail.campxusainc.com'
    })).toThrow();

    expect(() => loadConfig({
      ...baseEnv,
      ...oauth,
      NODE_ENV: 'production',
      CONNECTOR_ALLOWED_HOSTS: 'other.example.com',
      OAUTH_ISSUER: 'https://domail.campxusainc.com'
    })).toThrow();
  });

  it('caps search-source fetches at 512 KiB independently of the full-message cap', () => {
    expect(loadConfig({
      ...baseEnv,
      MAIL_SEARCH_SOURCE_BYTES: String(512 * 1024)
    }).searchSourceBytes).toBe(512 * 1024);
    expect(() => loadConfig({
      ...baseEnv,
      MAIL_SEARCH_SOURCE_BYTES: String(512 * 1024 + 1)
    })).toThrow();
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

  it('accepts only bounded JSON request limits between 32 KiB and 2 MiB', () => {
    expect(loadConfig({ ...baseEnv, CONNECTOR_JSON_LIMIT: '32kb' }).jsonLimit).toBe('32kb');
    expect(loadConfig({ ...baseEnv, CONNECTOR_JSON_LIMIT: '2mb' }).jsonLimit).toBe('2mb');
    expect(() => loadConfig({ ...baseEnv, CONNECTOR_JSON_LIMIT: '31kb' })).toThrow();
    expect(() => loadConfig({ ...baseEnv, CONNECTOR_JSON_LIMIT: '100mb' })).toThrow();
    expect(() => loadConfig({ ...baseEnv, CONNECTOR_JSON_LIMIT: 'unlimited' })).toThrow();
  });
});
