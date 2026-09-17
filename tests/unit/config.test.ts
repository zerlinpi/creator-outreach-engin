import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/config.ts';

const baseEnv = {
  MAIL_USERNAME: 'collab@campxusainc.com',
  MAIL_APP_PASSWORD: 'app-secret',
  CONNECTOR_AUTH_TOKEN: 'connector-secret',
} as NodeJS.ProcessEnv;

test('loadConfig applies Alibaba Mail TLS defaults', () => {
  const config = loadConfig(baseEnv);
  assert.equal(config.imap.host, 'imap.qiye.aliyun.com');
  assert.equal(config.imap.port, 993);
  assert.equal(config.imap.secure, true);
  assert.equal(config.smtp.host, 'smtp.qiye.aliyun.com');
  assert.equal(config.smtp.port, 465);
  assert.equal(config.smtp.secure, true);
  assert.equal(config.fromName, 'CAMPX');
  assert.equal(config.port, 3000);
});

test('loadConfig requires credentials and connector token', () => {
  assert.throws(() => loadConfig({ ...baseEnv, MAIL_APP_PASSWORD: '' }), /MAIL_APP_PASSWORD/);
  assert.throws(() => loadConfig({ ...baseEnv, MAIL_USERNAME: '' }), /MAIL_USERNAME/);
  assert.throws(() => loadConfig({ ...baseEnv, CONNECTOR_AUTH_TOKEN: '' }), /CONNECTOR_AUTH_TOKEN/);
});

test('loadConfig rejects invalid ports', () => {
  assert.throws(() => loadConfig({ ...baseEnv, MAIL_IMAP_PORT: 'not-a-number' }), /MAIL_IMAP_PORT/);
  assert.throws(() => loadConfig({ ...baseEnv, MAIL_SMTP_PORT: '70000' }), /MAIL_SMTP_PORT/);
});
