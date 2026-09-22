import type { AppConfig, MailAccountConfig } from '../config.js';
import { ConnectorError } from '../errors.js';
import { decodeMessageRef, ImapMailClient } from './imap-client.js';
import { SmtpMailClient } from './smtp-client.js';

export type MailAccountSource = 'environment' | 'ui';

export interface MailAccountRuntime {
  id: string;
  address: string;
  fromName: string;
  source?: MailAccountSource;
  imap: ImapMailClient;
  smtp: SmtpMailClient;
}

const ACCOUNT_ID = /^[a-z][a-z0-9_]{0,31}$/;

export function createMailAccountRuntime(account: MailAccountConfig, source: MailAccountSource = 'environment'): MailAccountRuntime {
  return {
    id: account.id,
    address: account.username,
    fromName: account.fromName,
    source,
    imap: new ImapMailClient(account, account.id, account.messageRefSecret),
    smtp: new SmtpMailClient(account)
  };
}

export class MailAccountRegistry {
  private readonly accounts = new Map<string, MailAccountRuntime>();
  private defaultId?: string;

  constructor(
    accounts: MailAccountRuntime[] = [],
    defaultAccount?: string,
    private readonly messageRefSecret?: string
  ) {
    for (const account of accounts) this.upsert(account);
    if (defaultAccount) this.setDefault(defaultAccount);
    else this.defaultId = accounts[0]?.id;
  }

  get size(): number {
    return this.accounts.size;
  }

  get defaultAccountId(): string | undefined {
    return this.defaultId;
  }

  list(): MailAccountRuntime[] {
    return [...this.accounts.values()];
  }

  has(id: string): boolean {
    return this.accounts.has(id.trim().toLowerCase());
  }

  upsert(account: MailAccountRuntime): void {
    if (!ACCOUNT_ID.test(account.id)) throw new Error('Invalid mail account id.');
    this.accounts.set(account.id, account);
    this.defaultId ??= account.id;
  }

  remove(id: string): void {
    const normalized = id.trim().toLowerCase();
    this.accounts.delete(normalized);
    if (this.defaultId === normalized) this.defaultId = this.accounts.keys().next().value;
  }

  setDefault(id: string): void {
    const normalized = id.trim().toLowerCase();
    if (!this.accounts.has(normalized)) throw new ConnectorError('ACCOUNT_NOT_FOUND', 'The requested mail account is not configured.');
    this.defaultId = normalized;
  }

  resolve(account?: string): MailAccountRuntime {
    const requested = account?.trim().toLowerCase();
    if (!requested) {
      if (this.accounts.size === 0) throw new ConnectorError('ACCOUNT_NOT_FOUND', 'No mail account is configured.');
      if (this.accounts.size > 1) {
        throw new ConnectorError(
          'ACCOUNT_REQUIRED',
          'Multiple mail accounts are configured. Specify account explicitly, or use all_accounts for a cross-account search.'
        );
      }
      return this.accounts.values().next().value as MailAccountRuntime;
    }

    const runtime = this.accounts.get(requested);
    if (!runtime) throw new ConnectorError('ACCOUNT_NOT_FOUND', 'The requested mail account is not configured.');
    return runtime;
  }

  resolveForMessage(messageRef: string, requestedAccount?: string): MailAccountRuntime {
    if (this.messageRefSecret) {
      const encodedAccount = decodeMessageRef(messageRef, this.messageRefSecret).account;
      if (encodedAccount && requestedAccount && encodedAccount !== requestedAccount.trim().toLowerCase()) {
        throw new ConnectorError('ACCOUNT_MISMATCH', 'The message reference belongs to a different mail account.');
      }
      return this.resolve(encodedAccount ?? requestedAccount);
    }

    let encodedAccount: string | undefined;
    try {
      encodedAccount = decodeMessageRef(messageRef).account;
    } catch {
      return this.resolve(requestedAccount);
    }
    if (encodedAccount && requestedAccount && encodedAccount !== requestedAccount.trim().toLowerCase()) {
      throw new ConnectorError('ACCOUNT_MISMATCH', 'The message reference belongs to a different mail account.');
    }
    return this.resolve(encodedAccount ?? requestedAccount);
  }
}

export function createMailAccountRegistry(config: AppConfig): MailAccountRegistry {
  const definitions = Object.values(config.accounts ?? {});
  const runtimes = definitions.map((account) => createMailAccountRuntime(account, 'environment'));
  return new MailAccountRegistry(runtimes, config.defaultAccount, config.messageRefSecret);
}
