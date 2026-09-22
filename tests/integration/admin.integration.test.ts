import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { createHttpApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { EncryptedAccountStore } from '../../src/mail/account-store.js';
import { MailAccountRegistry } from '../../src/mail/accounts.js';

const servers: Array<{ close(cb?: (err?: Error) => void): void }> = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('Mailbox Manager admin UI', () => {
  it('boots with zero mailboxes, requires Basic auth, and hot-adds encrypted accounts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mail-admin-')); dirs.push(dir);
    const config = loadConfig({
      CONNECTOR_AUTH_TOKEN: '1234567890abcdef1234567890abcdef',
      CONNECTOR_ALLOWED_HOSTS: '127.0.0.1',
      MAIL_ADMIN_PASSWORD: 'admin-password-1234',
      MAIL_ACCOUNT_STORE_KEY: '0123456789abcdef0123456789abcdef',
      MAIL_ACCOUNT_STORE_PATH: join(dir, 'accounts.json')
    });
    const registry = new MailAccountRegistry();
    const store = new EncryptedAccountStore(config.mailAdmin!.storePath, config.mailAdmin!.storeKey);

    const app = createHttpApp({
      authToken: config.authToken,
      registry,
      allowedHosts: ['127.0.0.1'],
      admin: config.mailAdmin,
      accountStore: store,
      baseConfig: config
    });
    const server = app.listen(0, '127.0.0.1'); servers.push(server);
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    const root = 'http://127.0.0.1:' + port;
    const auth = 'Basic ' + Buffer.from('admin:admin-password-1234').toString('base64');

    expect((await fetch(root + '/admin')).status).toBe(401);
    const adminPage = await fetch(root + '/admin', { headers: { authorization: auth } });
    expect(adminPage.status).toBe(200);
    expect(adminPage.headers.get('cache-control')).toBe('no-store');
    expect(adminPage.headers.get('x-frame-options')).toBe('DENY');

    const adminHtml = await adminPage.text();
    const scriptMatch = adminHtml.match(/<script>([\\s\\S]*?)<\\/script>/);
    expect(scriptMatch).not.toBeNull();
    expect(() => new Script(scriptMatch![1])).not.toThrow();

    const created = await fetch(root + '/admin/api/accounts', {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'brand10',
        username: 'mail@brand10.example',
        appPassword: 'mailbox-secret',
        fromName: 'Brand 10',
        imapHost: 'imap.brand10.example',
        imapPort: 993,
        smtpHost: 'smtp.brand10.example',
        smtpPort: 465
      })
    });
    expect(created.status).toBe(201);

    const crossOrigin = await fetch(root + '/admin/api/default', {
      method: 'POST',
      headers: {
        authorization: auth,
        origin: 'https://evil.example',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ id: 'brand10' })
    });
    expect(crossOrigin.status).toBe(403);
    expect(registry.resolve('brand10').address).toBe('mail@brand10.example');

    const listing = await (await fetch(root + '/admin/api/accounts', { headers: { authorization: auth } })).json() as any;
    expect(listing.accounts[0]).toMatchObject({ id: 'brand10', source: 'ui', username: 'mail@brand10.example' });
    expect(JSON.stringify(listing)).not.toContain('mailbox-secret');
  });
});
