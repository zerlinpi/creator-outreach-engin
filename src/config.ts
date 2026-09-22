import { z } from 'zod';
import type { OAuthConfig } from './auth/oauth.js';

const PortSchema = z.coerce.number().int().min(1).max(65535);
const TimeoutSchema = z.coerce.number().int().min(1_000).max(120_000);
const ByteSizeSchema = z.coerce.number().int().min(32 * 1024).max(25 * 1024 * 1024);
const EmailSchema = z.string().email();
const AccountIdSchema = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, 'Account ids must start with a letter and contain only lowercase letters, numbers, and underscores.');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  MAIL_USERNAME: EmailSchema.optional(),
  MAIL_APP_PASSWORD: z.string().min(1).optional(),
  MAIL_ACCOUNTS: z.string().optional(),
  MAIL_DEFAULT_ACCOUNT: z.string().optional(),
  MAIL_IMAP_HOST: z.string().min(1).default('imap.qiye.aliyun.com'),
  MAIL_IMAP_PORT: PortSchema.default(993),
  MAIL_SMTP_HOST: z.string().min(1).default('smtp.qiye.aliyun.com'),
  MAIL_SMTP_PORT: PortSchema.default(465),
  MAIL_FROM_NAME: z.string().min(1).default('CAMPX'),
  MAIL_CONNECTION_TIMEOUT_MS: TimeoutSchema.default(15_000),
  MAIL_GREETING_TIMEOUT_MS: TimeoutSchema.default(10_000),
  MAIL_SOCKET_TIMEOUT_MS: TimeoutSchema.default(30_000),
  MAIL_MAX_MESSAGE_BYTES: ByteSizeSchema.default(10 * 1024 * 1024),
  MAIL_SEARCH_SOURCE_BYTES: ByteSizeSchema.default(128 * 1024),
  MAIL_ADMIN_PASSWORD: z.string().min(16).optional(),
  MAIL_ACCOUNT_STORE_KEY: z.string().min(32).optional(),
  MAIL_ACCOUNT_STORE_PATH: z.string().min(1).default('./data/mail-accounts.enc.json'),
  MAIL_MAX_ACCOUNTS: z.coerce.number().int().min(1).max(100).default(50),
  CONNECTOR_AUTH_TOKEN: z.string().min(32),
  CONNECTOR_ALLOWED_HOSTS: z.string().optional(),
  CONNECTOR_JSON_LIMIT: z.string().min(1).default('1mb'),
  OAUTH_ISSUER: z.string().optional(),
  OAUTH_LOGIN_PASSWORD: z.string().min(16).optional(),
  OAUTH_SIGNING_SECRET: z.string().min(32).optional(),
  PORT: PortSchema.default(3000)
});

export interface TransportConfig {
  host: string;
  port: number;
  secure: true;
  connectionTimeout: number;
  greetingTimeout: number;
  socketTimeout: number;
}

export interface MailRuntimeConfig {
  username: string;
  appPassword: string;
  fromName: string;
  maxMessageBytes: number;
  searchSourceBytes: number;
  imap: TransportConfig;
  smtp: TransportConfig;
}

export interface MailAccountConfig extends MailRuntimeConfig {
  id: string;
}

export interface MailAdminConfig {
  password: string;
  storeKey: string;
  storePath: string;
  maxAccounts: number;
}

export interface AppConfig extends MailRuntimeConfig {
  authToken: string;
  allowedHosts?: string[];
  jsonLimit: string;
  port: number;
  oauth?: OAuthConfig;
  mailAdmin?: MailAdminConfig;
  defaultAccount?: string;
  accounts?: Record<string, MailAccountConfig>;
}

function isSafeHost(value: string): boolean {
  return value.length <= 253 && !value.includes('://') && !/[/*]/.test(value) && !value.includes(':');
}

function parseList(value?: string): string[] | undefined {
  if (!value) return undefined;
  const values = [...new Set(value.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean))];
  if (values.some((host) => !isSafeHost(host))) {
    throw new Error('CONNECTOR_ALLOWED_HOSTS must contain only hostnames or IPv4 addresses without schemes, ports, paths, or wildcards.');
  }
  return values.length ? values : undefined;
}

function parseAccountIds(value?: string): string[] {
  if (!value?.trim()) return [];
  const raw = value.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  const unique = [...new Set(raw)];
  if (unique.length !== raw.length) throw new Error('MAIL_ACCOUNTS must not contain duplicate account ids.');
  return unique.map((id) => AccountIdSchema.parse(id));
}

function validateJsonLimit(value: string): string {
  const normalized = value.trim().toLowerCase();
  const match = /^(\d+)(kb|mb)$/.exec(normalized);
  if (!match) throw new Error('CONNECTOR_JSON_LIMIT must use an integer kb or mb value between 32kb and 2mb.');
  const amount = Number(match[1]);
  const bytes = amount * (match[2] === 'mb' ? 1024 * 1024 : 1024);
  if (!Number.isSafeInteger(bytes) || bytes < 32 * 1024 || bytes > 2 * 1024 * 1024) {
    throw new Error('CONNECTOR_JSON_LIMIT must be between 32kb and 2mb.');
  }
  return normalized;
}

function parseOAuthConfig(parsed: z.infer<typeof EnvSchema>, allowedHosts?: string[]): OAuthConfig | undefined {
  const values = [parsed.OAUTH_ISSUER, parsed.OAUTH_LOGIN_PASSWORD, parsed.OAUTH_SIGNING_SECRET];
  const configured = values.filter(Boolean).length;
  if (configured === 0) return undefined;
  if (configured !== values.length) throw new Error('OAUTH_ISSUER, OAUTH_LOGIN_PASSWORD, and OAUTH_SIGNING_SECRET must be configured together.');

  const issuerUrl = new URL(parsed.OAUTH_ISSUER!);
  if (issuerUrl.username || issuerUrl.password || issuerUrl.search || issuerUrl.hash || issuerUrl.pathname !== '/') {
    throw new Error('OAUTH_ISSUER must be an origin URL without credentials, path, query, or fragment.');
  }
  if (parsed.NODE_ENV === 'production' && issuerUrl.protocol !== 'https:') throw new Error('OAUTH_ISSUER must use HTTPS in production.');
  if (parsed.NODE_ENV === 'production' && allowedHosts && !allowedHosts.includes(issuerUrl.hostname.toLowerCase())) {
    throw new Error('OAUTH_ISSUER hostname must be present in CONNECTOR_ALLOWED_HOSTS.');
  }
  return { issuer: issuerUrl.origin, loginPassword: parsed.OAUTH_LOGIN_PASSWORD!, signingSecret: parsed.OAUTH_SIGNING_SECRET! };
}

function parseAdminConfig(parsed: z.infer<typeof EnvSchema>): MailAdminConfig | undefined {
  const configured = [parsed.MAIL_ADMIN_PASSWORD, parsed.MAIL_ACCOUNT_STORE_KEY].filter(Boolean).length;
  if (configured === 0) return undefined;
  if (configured !== 2) throw new Error('MAIL_ADMIN_PASSWORD and MAIL_ACCOUNT_STORE_KEY must be configured together.');
  return {
    password: parsed.MAIL_ADMIN_PASSWORD!,
    storeKey: parsed.MAIL_ACCOUNT_STORE_KEY!,
    storePath: parsed.MAIL_ACCOUNT_STORE_PATH,
    maxAccounts: parsed.MAIL_MAX_ACCOUNTS
  };
}

function sharedTransport(parsed: z.infer<typeof EnvSchema>) {
  const timeouts = {
    connectionTimeout: parsed.MAIL_CONNECTION_TIMEOUT_MS,
    greetingTimeout: parsed.MAIL_GREETING_TIMEOUT_MS,
    socketTimeout: parsed.MAIL_SOCKET_TIMEOUT_MS
  };
  return {
    imap: { host: parsed.MAIL_IMAP_HOST, port: parsed.MAIL_IMAP_PORT, secure: true as const, ...timeouts },
    smtp: { host: parsed.MAIL_SMTP_HOST, port: parsed.MAIL_SMTP_PORT, secure: true as const, ...timeouts }
  };
}

function buildAccount(id: string, username: string, appPassword: string, fromName: string, parsed: z.infer<typeof EnvSchema>, env: NodeJS.ProcessEnv): MailAccountConfig {
  const prefix = 'MAIL_' + id.toUpperCase() + '_';
  const base = sharedTransport(parsed);
  return {
    id,
    username,
    appPassword,
    fromName,
    maxMessageBytes: parsed.MAIL_MAX_MESSAGE_BYTES,
    searchSourceBytes: parsed.MAIL_SEARCH_SOURCE_BYTES,
    imap: {
      ...base.imap,
      host: env[prefix + 'IMAP_HOST']?.trim() || base.imap.host,
      port: PortSchema.parse(env[prefix + 'IMAP_PORT'] ?? base.imap.port)
    },
    smtp: {
      ...base.smtp,
      host: env[prefix + 'SMTP_HOST']?.trim() || base.smtp.host,
      port: PortSchema.parse(env[prefix + 'SMTP_PORT'] ?? base.smtp.port)
    }
  };
}

function parseAccounts(parsed: z.infer<typeof EnvSchema>, env: NodeJS.ProcessEnv): {
  defaultAccount?: string;
  accounts: Record<string, MailAccountConfig>;
} {
  const ids = parseAccountIds(parsed.MAIL_ACCOUNTS);
  if (!ids.length) {
    if (!parsed.MAIL_USERNAME || !parsed.MAIL_APP_PASSWORD) return { accounts: {} };
    const id = AccountIdSchema.parse((parsed.MAIL_DEFAULT_ACCOUNT ?? 'default').trim().toLowerCase());
    return {
      defaultAccount: id,
      accounts: { [id]: buildAccount(id, parsed.MAIL_USERNAME, parsed.MAIL_APP_PASSWORD, parsed.MAIL_FROM_NAME, parsed, env) }
    };
  }

  const accounts: Record<string, MailAccountConfig> = {};
  for (const id of ids) {
    const prefix = 'MAIL_' + id.toUpperCase() + '_';
    accounts[id] = buildAccount(
      id,
      EmailSchema.parse(env[prefix + 'USERNAME']),
      z.string().min(1).parse(env[prefix + 'APP_PASSWORD']),
      z.string().min(1).parse(env[prefix + 'FROM_NAME']),
      parsed,
      env
    );
  }

  const defaultAccount = AccountIdSchema.parse((parsed.MAIL_DEFAULT_ACCOUNT ?? ids[0]).trim().toLowerCase());
  if (!accounts[defaultAccount]) throw new Error('MAIL_DEFAULT_ACCOUNT must name one of the configured MAIL_ACCOUNTS.');
  return { defaultAccount, accounts };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.parse(env);
  const allowedHosts = parseList(parsed.CONNECTOR_ALLOWED_HOSTS);
  const jsonLimit = validateJsonLimit(parsed.CONNECTOR_JSON_LIMIT);
  const oauth = parseOAuthConfig(parsed, allowedHosts);
  const mailAdmin = parseAdminConfig(parsed);

  if (parsed.NODE_ENV === 'production' && !allowedHosts?.length) throw new Error('CONNECTOR_ALLOWED_HOSTS is required in production.');
  if (parsed.MAIL_SEARCH_SOURCE_BYTES > parsed.MAIL_MAX_MESSAGE_BYTES) throw new Error('MAIL_SEARCH_SOURCE_BYTES must not exceed MAIL_MAX_MESSAGE_BYTES.');

  const { defaultAccount, accounts } = parseAccounts(parsed, env);
  if (!Object.keys(accounts).length && !mailAdmin) {
    throw new Error('Configure at least one mailbox or enable the Mailbox Manager with MAIL_ADMIN_PASSWORD and MAIL_ACCOUNT_STORE_KEY.');
  }

  const base = sharedTransport(parsed);
  const defaultConfig = defaultAccount ? accounts[defaultAccount] : undefined;
  return {
    username: defaultConfig?.username ?? '',
    appPassword: defaultConfig?.appPassword ?? '',
    fromName: defaultConfig?.fromName ?? parsed.MAIL_FROM_NAME,
    authToken: parsed.CONNECTOR_AUTH_TOKEN,
    allowedHosts,
    jsonLimit,
    port: parsed.PORT,
    maxMessageBytes: parsed.MAIL_MAX_MESSAGE_BYTES,
    searchSourceBytes: parsed.MAIL_SEARCH_SOURCE_BYTES,
    oauth,
    mailAdmin,
    imap: defaultConfig?.imap ?? base.imap,
    smtp: defaultConfig?.smtp ?? base.smtp,
    defaultAccount,
    accounts
  };
}
