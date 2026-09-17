import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

const baseEnv = {
  MAIL_USERNAME: 'campx@example.com',
  MAIL_APP_PASSWORD: 'app-password',
  CONNECTOR_AUTH_TOKEN: 'test-token-1234567890'
};

describe('loadConfig', () => {
  it('requires mailbox credentials and connector token', () => {
    expect(() => loadConfig({})).toThrow();
  });

  it('uses secure Alibaba Mail defaults', () => {
    const config = loadConfig(baseEnv);
    expect(config.imap).toMatchObject({ host: 'imap.qiye.aliyun.com', port: 993, secure: true });
    expect(config.smtp).toMatchObject({ host: 'smtp.qiye.aliyun.com', port: 465, secure: true });
    expect(config.fromName).toBe('CAMPX');
    expect(config.jsonLimit).toBe('1mb');
  });

  it('parses a deployment host allowlist', () => {
    const config = loadConfig({ ...baseEnv, CONNECTOR_ALLOWED_HOSTS: 'mail.campxusainc.com, localhost ,127.0.0.1' });
    expect(config.allowedHosts).toEqual(['mail.campxusainc.com', 'localhost', '127.0.0.1']);
  });

  it('rejects invalid numeric ports', () => {
    expect(() => loadConfig({ ...baseEnv, MAIL_IMAP_PORT: 'nope' })).toThrow();
    expect(() => loadConfig({ ...baseEnv, MAIL_SMTP_PORT: '70000' })).toThrow();
  });
});
