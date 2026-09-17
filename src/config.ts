import { z } from 'zod';

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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.parse(env);
  const allowedHosts = parseList(parsed.CONNECTOR_ALLOWED_HOSTS);

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
    jsonLimit: parsed.CONNECTOR_JSON_LIMIT,
    port: parsed.PORT,
    maxMessageBytes: parsed.MAIL_MAX_MESSAGE_BYTES,
    searchSourceBytes: parsed.MAIL_SEARCH_SOURCE_BYTES,
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
