import { z } from 'zod';
import type { OAuthConfig } from './auth/oauth.js';

const PortSchema = z.coerce.number().int().min(1).max(65535);
const TimeoutSchema = z.coerce.number().int().min(1_000).max(120_000);
const ByteSizeSchema = z.coerce.number().int().min(32 * 1024).max(25 * 1024 * 1024);

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  MAIL_USERNAME: z.string().email(),
  MAIL_APP_PASSWORD: z.string().min(1),
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
  CONNECTOR_AUTH_TOKEN: z.string().min(32),
  CONNECTOR_ALLOWED_HOSTS: z.string().optional(),
  CONNECTOR_JSON_LIMIT: z.string().min(1).default('1mb'),
  OAUTH_ISSUER: z.string().optional(),
  OAUTH_LOGIN_PASSWORD: z.string().min(16).optional(),
  OAUTH_SIGNING_SECRET: z.string().min(32).optional(),
  PORT: PortSchema.default(3000)
});

interface TransportConfig {
  host: string;
  port: number;
  secure: true;
  connectionTimeout: number;
  greetingTimeout: number;
  socketTimeout: number;
}

export interface AppConfig {
  username: string;
  appPassword: string;
  fromName: string;
  authToken: string;
  allowedHosts?: string[];
  jsonLimit: string;
  port: number;
  maxMessageBytes: number;
  searchSourceBytes: number;
  oauth?: OAuthConfig;
  imap: TransportConfig;
  smtp: TransportConfig;
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

function validateJsonLimit(value: string): string {
  const normalized = value.trim().toLowerCase();
  const match = /^(\d+)(kb|mb)$/.exec(normalized);
  if (!match) {
    throw new Error('CONNECTOR_JSON_LIMIT must use an integer kb or mb value between 32kb and 2mb.');
  }

  const amount = Number(match[1]);
  const bytes = amount * (match[2] === 'mb' ? 1024 * 1024 : 1024);
  if (!Number.isSafeInteger(bytes) || bytes < 32 * 1024 || bytes > 2 * 1024 * 1024) {
    throw new Error('CONNECTOR_JSON_LIMIT must be between 32kb and 2mb.');
  }
  return normalized;
}

function parseOAuthConfig(
  parsed: z.infer<typeof EnvSchema>,
  allowedHosts?: string[]
): OAuthConfig | undefined {
  const values = [parsed.OAUTH_ISSUER, parsed.OAUTH_LOGIN_PASSWORD, parsed.OAUTH_SIGNING_SECRET];
  const configured = values.filter((value) => Boolean(value)).length;
  if (configured === 0) return undefined;
  if (configured !== values.length) {
    throw new Error('OAUTH_ISSUER, OAUTH_LOGIN_PASSWORD, and OAUTH_SIGNING_SECRET must be configured together.');
  }

  const issuerUrl = new URL(parsed.OAUTH_ISSUER!);
  if (issuerUrl.username || issuerUrl.password || issuerUrl.search || issuerUrl.hash || issuerUrl.pathname !== '/') {
    throw new Error('OAUTH_ISSUER must be an origin URL without credentials, path, query, or fragment.');
  }
  if (parsed.NODE_ENV === 'production' && issuerUrl.protocol !== 'https:') {
    throw new Error('OAUTH_ISSUER must use HTTPS in production.');
  }
  if (parsed.NODE_ENV === 'production' && allowedHosts && !allowedHosts.includes(issuerUrl.hostname.toLowerCase())) {
    throw new Error('OAUTH_ISSUER hostname must be present in CONNECTOR_ALLOWED_HOSTS.');
  }

  return {
    issuer: issuerUrl.origin,
    loginPassword: parsed.OAUTH_LOGIN_PASSWORD!,
    signingSecret: parsed.OAUTH_SIGNING_SECRET!
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.parse(env);
  const allowedHosts = parseList(parsed.CONNECTOR_ALLOWED_HOSTS);
  const jsonLimit = validateJsonLimit(parsed.CONNECTOR_JSON_LIMIT);
  const oauth = parseOAuthConfig(parsed, allowedHosts);

  if (parsed.NODE_ENV === 'production' && !allowedHosts?.length) {
    throw new Error('CONNECTOR_ALLOWED_HOSTS is required in production.');
  }
  if (parsed.MAIL_SEARCH_SOURCE_BYTES > parsed.MAIL_MAX_MESSAGE_BYTES) {
    throw new Error('MAIL_SEARCH_SOURCE_BYTES must not exceed MAIL_MAX_MESSAGE_BYTES.');
  }

  const timeouts = {
    connectionTimeout: parsed.MAIL_CONNECTION_TIMEOUT_MS,
    greetingTimeout: parsed.MAIL_GREETING_TIMEOUT_MS,
    socketTimeout: parsed.MAIL_SOCKET_TIMEOUT_MS
  };

  return {
    username: parsed.MAIL_USERNAME,
    appPassword: parsed.MAIL_APP_PASSWORD,
    fromName: parsed.MAIL_FROM_NAME,
    authToken: parsed.CONNECTOR_AUTH_TOKEN,
    allowedHosts,
    jsonLimit,
    port: parsed.PORT,
    maxMessageBytes: parsed.MAIL_MAX_MESSAGE_BYTES,
    searchSourceBytes: parsed.MAIL_SEARCH_SOURCE_BYTES,
    oauth,
    imap: {
      host: parsed.MAIL_IMAP_HOST,
      port: parsed.MAIL_IMAP_PORT,
      secure: true,
      ...timeouts
    },
    smtp: {
      host: parsed.MAIL_SMTP_HOST,
      port: parsed.MAIL_SMTP_PORT,
      secure: true,
      ...timeouts
    }
  };
}
