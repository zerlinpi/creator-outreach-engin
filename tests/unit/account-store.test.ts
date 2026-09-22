import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EncryptedAccountStore } from '../../src/mail/account-store.js';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

function base() {
  return {
    maxMessageBytes: 1024 * 1024,
    searchSourceBytes: 64 * 1024,
    imap: { host: 'imap.default.test', port: 993, secure: true as const, connectionTimeout: 15000, greetingTimeout: 10000, socketTimeout: 30000 },
    smtp: { host: 'smtp.default.test', port: 465, secure: true as const, connectionTimeout: 15000, greetingTimeout: 10000, socketTimeout: 30000 }
  };
}

describe('EncryptedAccountStore', () => {
  it('stores many mailbox credentials without writing passwords in plaintext', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mail-store-')); dirs.push(dir);
    const path = join(dir, 'accounts.json');
    const store = new EncryptedAccountStore(path, '0123456789abcdef0123456789abcdef', 20);

    for (let index = 0; index < 10; index += 1) {
      await store.upsert({
        id: 'brand' + index,
        username: 'brand' + index + '@example.com',
        appPassword: 'secret-password-' + index,
        fromName: 'Brand ' + index,
        imapHost: 'imap.example.com',
        imapPort: 993,
        smtpHost: 'smtp.example.com',
        smtpPort: 465
      });
    }

    const raw = await readFile(path, 'utf8');
    expect(raw).not.toContain('secret-password-');
    const loaded = await store.loadAll(base());
    expect(loaded.accounts).toHaveLength(10);
    expect(loaded.accounts[7].appPassword).toBe('secret-password-7');
    expect((await store.list())[0]).not.toHaveProperty('appPassword');
  });

  it('serializes concurrent mailbox writes without losing accounts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mail-store-')); dirs.push(dir);
    const store = new EncryptedAccountStore(join(dir, 'accounts.json'), '0123456789abcdef0123456789abcdef', 30);

    await Promise.all(Array.from({ length: 20 }, (_, index) => store.upsert({
      id: 'parallel' + index,
      username: 'parallel' + index + '@example.com',
      appPassword: 'parallel-secret-' + index,
      fromName: 'Parallel ' + index,
      imapHost: 'imap.example.com',
      imapPort: 993,
      smtpHost: 'smtp.example.com',
      smtpPort: 465
    })));

    const loaded = await store.loadAll(base());
    expect(loaded.accounts).toHaveLength(20);
    expect(new Set(loaded.accounts.map((account) => account.id)).size).toBe(20);
  });

  it('supports password-preserving edits and an external default account id', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mail-store-')); dirs.push(dir);
    const store = new EncryptedAccountStore(join(dir, 'accounts.json'), '0123456789abcdef0123456789abcdef');
    await store.upsert({
      id: 'geteen', username: 'mail@geteen.example', appPassword: 'first-secret', fromName: 'GETEEN',
      imapHost: 'imap.example.com', imapPort: 993, smtpHost: 'smtp.example.com', smtpPort: 465
    });
    await store.setDefault('environment_account');
    expect((await store.loadAll(base())).defaultAccount).toBe('environment_account');
    expect((await store.get('geteen'))?.appPassword).toBe('first-secret');
  });
});
