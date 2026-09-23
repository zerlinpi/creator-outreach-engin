import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { MailAccountConfig, MailRuntimeConfig } from '../config.js';
import { isHostnameOrIpv4 } from '../network.js';

const MAX_STORE_BYTES = 4 * 1024 * 1024;
const SmtpSecuritySchema = z.enum(['tls', 'starttls']);
const AccountIdSchema = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
const HostSchema = z.string().trim().min(1).max(253).refine(isHostnameOrIpv4, 'Invalid mailbox host.');
const SenderNameSchema = z.string().trim().min(1).max(120).refine(
  (value) => !/[\r\n]/.test(value),
  'Sender name must not contain CR or LF characters.'
);
const PasswordSchema = z.string().min(1).max(4096);

const AccountSchema = z.object({
  id: AccountIdSchema,
  username: z.string().max(320).email(),
  appPassword: PasswordSchema,
  fromName: SenderNameSchema,
  imapHost: HostSchema,
  imapPort: z.number().int().min(1).max(65535),
  smtpHost: HostSchema,
  smtpPort: z.number().int().min(1).max(65535),
  smtpSecurity: SmtpSecuritySchema.default('tls')
});

export type ManagedAccountInput = z.input<typeof AccountSchema>;

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
  smtpSecurity?: 'tls' | 'starttls';
  secret: EncryptedSecret;
}

interface StoreDocument {
  version: 1;
  defaultAccount?: string;
  accounts: StoredAccount[];
}

const EncryptedSecretSchema = z.object({
  iv: z.string().length(16).regex(/^[A-Za-z0-9_-]+$/),
  tag: z.string().length(22).regex(/^[A-Za-z0-9_-]+$/),
  ciphertext: z.string().min(2).max(16_384).regex(/^[A-Za-z0-9_-]+$/)
});

const StoredAccountSchema = z.object({
  id: AccountIdSchema,
  username: z.string().max(320).email(),
  fromName: SenderNameSchema,
  imapHost: HostSchema,
  imapPort: z.number().int().min(1).max(65535),
  smtpHost: HostSchema,
  smtpPort: z.number().int().min(1).max(65535),
  smtpSecurity: SmtpSecuritySchema.optional(),
  secret: EncryptedSecretSchema
});

const StoreDocumentSchema = z.object({
  version: z.literal(1),
  defaultAccount: AccountIdSchema.optional(),
  accounts: z.array(StoredAccountSchema)
}).superRefine((document, context) => {
  const ids = new Set<string>();
  for (const account of document.accounts) {
    if (ids.has(account.id)) {
      context.addIssue({ code: 'custom', path: ['accounts'], message: 'Duplicate mailbox account id in encrypted store.' });
      return;
    }
    ids.add(account.id);
  }
});

export interface ManagedAccountMetadata {
  id: string;
  username: string;
  fromName: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: 'tls' | 'starttls';
  hasPassword: true;
}

function keyFromSecret(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

function encrypt(password: string, secret: string): EncryptedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFromSecret(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ciphertext: ciphertext.toString('base64url')
  };
}

function decrypt(value: EncryptedSecret, secret: string): string {
  const decipher = createDecipheriv('aes-256-gcm', keyFromSecret(secret), Buffer.from(value.iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(value.tag, 'base64url'));
  return PasswordSchema.parse(
    Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64url')), decipher.final()]).toString('utf8')
  );
}

function smtpSecurity(value: 'tls' | 'starttls') {
  return value === 'starttls' ? { secure: false, requireTLS: true } : { secure: true, requireTLS: undefined };
}

export class EncryptedAccountStore {
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly secret: string,
    private readonly maxAccounts = 50
  ) {}

  private async readDocument(): Promise<StoreDocument> {
    try {
      const file = await stat(this.filePath);
      if (file.size > MAX_STORE_BYTES) throw new Error('Mailbox account store is unexpectedly large.');
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = StoreDocumentSchema.parse(JSON.parse(raw));
      if (parsed.accounts.length > this.maxAccounts) throw new Error('Mailbox account store exceeds configured account limit.');
      return parsed;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { version: 1, accounts: [] };
      throw error;
    }
  }

  private async writeDocument(document: StoreDocument): Promise<void> {
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temp = this.filePath + '.tmp';
    await writeFile(temp, JSON.stringify(document, null, 2), { encoding: 'utf8', mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, this.filePath);
    await chmod(this.filePath, 0o600);
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationTail.then(operation, operation);
    this.mutationTail = run.then(() => undefined, () => undefined);
    return run;
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
      smtpSecurity: account.smtpSecurity ?? 'tls',
      hasPassword: true
    }));
  }

  async loadAll(base: Pick<MailRuntimeConfig, 'maxMessageBytes' | 'searchSourceBytes' | 'messageRefSecret' | 'imap' | 'smtp'>): Promise<{
    defaultAccount?: string;
    accounts: MailAccountConfig[];
  }> {
    const document = await this.readDocument();
    return {
      defaultAccount: document.defaultAccount,
      accounts: document.accounts.map((account) => {
        const security = account.smtpSecurity ?? 'tls';
        return {
          id: account.id,
          username: account.username,
          appPassword: decrypt(account.secret, this.secret),
          fromName: account.fromName,
          maxMessageBytes: base.maxMessageBytes,
          searchSourceBytes: base.searchSourceBytes,
          messageRefSecret: base.messageRefSecret,
          imap: { ...base.imap, host: account.imapHost, port: account.imapPort },
          smtp: {
            ...base.smtp,
            ...smtpSecurity(security),
            host: account.smtpHost,
            port: account.smtpPort
          }
        };
      })
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
      smtpPort: account.smtpPort,
      smtpSecurity: account.smtpSecurity ?? 'tls'
    };
  }

  async upsert(input: ManagedAccountInput): Promise<void> {
    const account = AccountSchema.parse(input);
    await this.mutate(async () => {
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
        smtpSecurity: account.smtpSecurity,
        secret: encrypt(account.appPassword, this.secret)
      };
      if (index >= 0) document.accounts[index] = stored;
      else {
        if (document.accounts.length >= this.maxAccounts) throw new Error('Mailbox Manager account limit reached.');
        document.accounts.push(stored);
      }
      await this.writeDocument(document);
    });
  }

  async remove(id: string): Promise<void> {
    await this.mutate(async () => {
      const document = await this.readDocument();
      document.accounts = document.accounts.filter((account) => account.id !== id);
      if (document.defaultAccount === id) document.defaultAccount = document.accounts[0]?.id;
      await this.writeDocument(document);
    });
  }

  async setDefault(id: string): Promise<void> {
    await this.mutate(async () => {
      const document = await this.readDocument();
      document.defaultAccount = id;
      await this.writeDocument(document);
    });
  }
}
