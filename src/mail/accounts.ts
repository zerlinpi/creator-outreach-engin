import type { AppConfig, MailAccountConfig } from '../config.js';
import { ConnectorError } from '../errors.js';
import { decodeMessageRef, ImapMailClient } from './imap-client.js';
import { SmtpMailClient } from './smtp-client.js';

export interface MailAccountRuntime {
  id: string;
  address: string;
  fromName: string;
  imap: ImapMailClient;
  smtp: SmtpMailClient;
}

const ACCOUNT_ID = /^[a-z][a-z0-9_]{0,31}$/;

function legacyAccount(config: AppConfig): MailAccountConfig {
  const id = config.defaultAccount ?? 'default';
  return {
    id,
    username: config.username,
    appPassword: config.appPassword,
    fromName: config.fromName,
    maxMessageBytes: config.maxMessageBytes,
    searchSourceBytes: config.searchSourceBytes,
    imap: config.imap,
    smtp: config.smtp
  };
}

export class MailAccountRegistry {
  private readonly accounts = new Map<string, MailAccountRuntime>();
  readonly defaultAccountId: string;

  constructor(accounts: MailAccountRuntime[], defaultAccount?: string) {
    if (!accounts.length) throw new Error('At least one mail account is required.');

    for (const account of accounts) {
      if (!ACCOUNT_ID.test(account.id)) throw new Error('Invalid mail account id.');
      if (this.accounts.has(account.id)) throw new Error('Duplicate mail account id.');
      this.accounts.set(account.id, account);
    }

    this.defaultAccountId = defaultAccount ?? accounts[0].id;
    if (!this.accounts.has(this.defaultAccountId)) {
      throw new Error('Default mail account is not configured.');
    }
  }

  get size(): number {
    return this.accounts.size;
  }

  list(): MailAccountRuntime[] {
    return [...this.accounts.values()];
  }

  resolve(account?: string): MailAccountRuntime {
    const id = account?.trim().toLowerCase() || this.defaultAccountId;
    const runtime = this.accounts.get(id);
    if (!runtime) {
      throw new ConnectorError('ACCOUNT_NOT_FOUND', 'The requested mail account is not configured.');
    }
    return runtime;
  }

  resolveForMessage(messageRef: string, requestedAccount?: string): MailAccountRuntime {
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
  const definitions = config.accounts && Object.keys(config.accounts).length
    ? Object.values(config.accounts)
    : [legacyAccount(config)];

  const runtimes = definitions.map((account) => ({
    id: account.id,
    address: account.username,
    fromName: account.fromName,
    imap: new ImapMailClient(account, account.id),
    smtp: new SmtpMailClient(account)
  }));

  return new MailAccountRegistry(runtimes, config.defaultAccount ?? runtimes[0].id);
}
