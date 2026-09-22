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

    expect((await fetch(root + '/favicon.ico')).status).toBe(204);
    expect((await fetch(root + '/admin')).status).toBe(401);
    const adminPage = await fetch(root + '/admin', { headers: { authorization: auth } });
    expect(adminPage.status).toBe(200);
    expect(adminPage.headers.get('cache-control')).toBe('no-store');
    expect(adminPage.headers.get('x-frame-options')).toBe('DENY');

    const adminHtml = await adminPage.text();
    const scriptStart = adminHtml.indexOf('<script>');
    const scriptEnd = adminHtml.indexOf('</script>', scriptStart);
    expect(scriptStart).toBeGreaterThanOrEqual(0);
    expect(scriptEnd).toBeGreaterThan(scriptStart);
    const adminScript = adminHtml.slice(scriptStart + '<script>'.length, scriptEnd);
    expect(() => new Script(adminScript)).not.toThrow();
    expect(adminHtml).not.toContain(' onclick=');
    expect(adminHtml).not.toContain(' onchange=');
    expect(adminHtml).toContain("actionButton('Test','test'");
    expect(adminHtml).not.toContain('cards.innerHTML');
    expect(adminHtml).toContain('id="addMailbox"');
    expect(adminHtml).toContain('id="cancelDialog"');

    const browserElements = new Map<string, BrowserElement>();
    const browserListeners = new Map<string, Map<string, (...args: any[]) => unknown>>();
    class BrowserElement {
      id = '';
      value = '';
      disabled = false;
      textContent = '';
      className = '';
      type = '';
      dataset: Record<string, string> = {};
      children: BrowserElement[] = [];
      private listeners = new Map<string, (...args: any[]) => unknown>();

      constructor(public readonly tagName = 'div') {}

      reset() {}
      showModal() {}
      close() {}
      append(...nodes: BrowserElement[]) { this.children.push(...nodes); }
      replaceChildren(...nodes: BrowserElement[]) { this.children = [...nodes]; }
      addEventListener(type: string, handler: (...args: any[]) => unknown) { this.listeners.set(type, handler); }
      getAttribute(name: string) {
        if (name === 'data-id') return this.dataset.id ?? null;
        if (name === 'data-action') return this.dataset.action ?? null;
        return null;
      }
      closest() { return null; }
      hasListener(type: string) { return this.listeners.has(type); }
    }
    const elementFor = (elementId: string) => {
      if (!browserElements.has(elementId)) {
        const element = new BrowserElement();
        element.id = elementId;
        browserElements.set(elementId, element);
        browserListeners.set(elementId, new Map());
        const originalAdd = element.addEventListener.bind(element);
        element.addEventListener = (type: string, handler: (...args: any[]) => unknown) => {
          browserListeners.get(elementId)!.set(type, handler);
          originalAdd(type, handler);
        };
      }
      return browserElements.get(elementId)!;
    };
    const browserAccount = {
      id: 'browser10',
      username: 'mail@browser10.example',
      fromName: '<b>Browser Brand</b>',
      source: 'ui',
      imapHost: 'imap.browser10.example',
      imapPort: 993,
      smtpHost: 'smtp.browser10.example',
      smtpPort: 465,
      smtpSecurity: 'tls'
    };
    const browserContext = {
      document: {
        getElementById: (elementId: string) => elementFor(elementId),
        createElement: (tagName: string) => new BrowserElement(tagName)
      },
      Element: BrowserElement,
      fetch: async () => ({ ok: true, json: async () => ({ accounts: [browserAccount] }) }),
      confirm: () => true,
      console
    };
    expect(() => new Script(adminScript).runInNewContext(browserContext)).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    expect(elementFor('summary').textContent).toBe('1 configured mailbox(es)');
    expect(elementFor('cards').children).toHaveLength(1);
    expect(elementFor('cards').children[0].children[2].textContent).toBe('<b>Browser Brand</b>');
    expect(browserListeners.get('addMailbox')?.has('click')).toBe(true);
    expect(browserListeners.get('provider')?.has('change')).toBe(true);
    expect(browserListeners.get('form')?.has('submit')).toBe(true);

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

    for (let index = 0; index < 10; index += 1) {
      await fetch(root + '/admin', { headers: { 'x-forwarded-for': '203.0.113.10' } });
    }
    const isolatedClient = await fetch(root + '/admin', {
      headers: {
        authorization: auth,
        'x-forwarded-for': '203.0.113.11'
      }
    });
    expect(isolatedClient.status).toBe(200);
  });
});
