import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { MailAccountConfig, MailRuntimeConfig } from '../config.js';

const AccountSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  username: z.string().email(),
  appPassword: z.string().min(1),
  fromName: z.string().min(1).max(120),
  imapHost: z.string().min(1).max(253),
  imapPort: z.number().int().min(1).max(65535),
  smtpHost: z.string().min(1).max(253),
  smtpPort: z.number().int().min(1).max(65535)
});

export type ManagedAccountInput = z.infer<typeof AccountSchema>;

interface EncryptedSecret {
  iv: string;
  tag: string;
  ciphertext: string;
}

interface StoredAccount {
  id: string;
  username: string;
  fromName: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  secret: EncryptedSecret;
}

interface StoreDocument {
  version: 1;
  defaultAccount?: string;
  accounts: StoredAccount[];
}

export interface ManagedAccountMetadata {
  id: string;
  username: string;
  fromName: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  hasPassword: true;
}

function keyFromSecret(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

function encrypt(password: string, secret: string): EncryptedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFromSecret(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), ciphertext: ciphertext.toString('base64url') };
}

function decrypt(value: EncryptedSecret, secret: string): string {
  const decipher = createDecipheriv('aes-256-gcm', keyFromSecret(secret), Buffer.from(value.iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(value.tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}

export class EncryptedAccountStore {
  constructor(
    private readonly filePath: string,
    private readonly secret: string,
    private readonly maxAccounts = 50
  ) {}

  private async readDocument(): Promise<StoreDocument> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as StoreDocument;
      if (parsed.version !== 1 || !Array.isArray(parsed.accounts)) throw new Error('Unsupported mailbox store format.');
      return parsed;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { version: 1, accounts: [] };
      throw error;
    }
  }

  private async writeDocument(document: StoreDocument): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temp = this.filePath + '.tmp';
    await writeFile(temp, JSON.stringify(document, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temp, this.filePath);
  }

  async list(): Promise<ManagedAccountMetadata[]> {
    const document = await this.readDocument();
    return document.accounts.map((account) => ({
      id: account.id,
      username: account.username,
      fromName: account.fromName,
      imapHost: account.imapHost,
      imapPort: account.imapPort,
      smtpHost: account.smtpHost,
      smtpPort: account.smtpPort,
      hasPassword: true
    }));
  }

  async loadAll(base: Pick<MailRuntimeConfig, 'maxMessageBytes' | 'searchSourceBytes' | 'imap' | 'smtp'>): Promise<{
    defaultAccount?: string;
    accounts: MailAccountConfig[];
  }> {
    const document = await this.readDocument();
    return {
      defaultAccount: document.defaultAccount,
      accounts: document.accounts.map((account) => ({
        id: account.id,
        username: account.username,
        appPassword: decrypt(account.secret, this.secret),
        fromName: account.fromName,
        maxMessageBytes: base.maxMessageBytes,
        searchSourceBytes: base.searchSourceBytes,
        imap: { ...base.imap, host: account.imapHost, port: account.imapPort },
        smtp: { ...base.smtp, host: account.smtpHost, port: account.smtpPort }
      }))
    };
  }

  async get(id: string): Promise<ManagedAccountInput | undefined> {
    const document = await this.readDocument();
    const account = document.accounts.find((item) => item.id === id);
    if (!account) return undefined;
    return {
      id: account.id,
      username: account.username,
      appPassword: decrypt(account.secret, this.secret),
      fromName: account.fromName,
      imapHost: account.imapHost,
      imapPort: account.imapPort,
      smtpHost: account.smtpHost,
      smtpPort: account.smtpPort
    };
  }

  async upsert(input: ManagedAccountInput): Promise<void> {
    const account = AccountSchema.parse(input);
    const document = await this.readDocument();
    const index = document.accounts.findIndex((item) => item.id === account.id);
    const stored: StoredAccount = {
      id: account.id,
      username: account.username.toLowerCase(),
      fromName: account.fromName,
      imapHost: account.imapHost,
      imapPort: account.imapPort,
      smtpHost: account.smtpHost,
      smtpPort: account.smtpPort,
      secret: encrypt(account.appPassword, this.secret)
    };
    if (index >= 0) document.accounts[index] = stored;
    else {
      if (document.accounts.length >= this.maxAccounts) throw new Error('Mailbox Manager account limit reached.');
      document.accounts.push(stored);
    }
    await this.writeDocument(document);
  }

  async remove(id: string): Promise<void> {
    const document = await this.readDocument();
    document.accounts = document.accounts.filter((account) => account.id !== id);
    if (document.defaultAccount === id) document.defaultAccount = document.accounts[0]?.id;
    await this.writeDocument(document);
  }

  async setDefault(id: string): Promise<void> {
    const document = await this.readDocument();
    document.defaultAccount = id;
    await this.writeDocument(document);
  }
}
