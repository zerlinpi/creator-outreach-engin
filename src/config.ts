import { z } from 'zod';

const PortSchema = z.coerce.number().int().min(1).max(65535);

const EnvSchema = z.object({
  MAIL_USERNAME: z.string().email(),
  MAIL_APP_PASSWORD: z.string().min(1),
  MAIL_IMAP_HOST: z.string().min(1).default('imap.qiye.aliyun.com'),
  MAIL_IMAP_PORT: PortSchema.default(993),
  MAIL_SMTP_HOST: z.string().min(1).default('smtp.qiye.aliyun.com'),
  MAIL_SMTP_PORT: PortSchema.default(465),
  MAIL_FROM_NAME: z.string().min(1).default('CAMPX'),
  CONNECTOR_AUTH_TOKEN: z.string().min(16),
  CONNECTOR_ALLOWED_HOSTS: z.string().optional(),
  CONNECTOR_JSON_LIMIT: z.string().min(1).default('1mb'),
  PORT: PortSchema.default(3000)
});

export interface AppConfig {
  username: string;
  appPassword: string;
  fromName: string;
  authToken: string;
  allowedHosts?: string[];
  jsonLimit: string;
  port: number;
  imap: { host: string; port: number; secure: true };
  smtp: { host: string; port: number; secure: true };
}

function parseList(value?: string): string[] | undefined {
  if (!value) return undefined;
  const values = [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
  return values.length ? values : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.parse(env);
  return {
    username: parsed.MAIL_USERNAME,
    appPassword: parsed.MAIL_APP_PASSWORD,
    fromName: parsed.MAIL_FROM_NAME,
    authToken: parsed.CONNECTOR_AUTH_TOKEN,
    allowedHosts: parseList(parsed.CONNECTOR_ALLOWED_HOSTS),
    jsonLimit: parsed.CONNECTOR_JSON_LIMIT,
    port: parsed.PORT,
    imap: { host: parsed.MAIL_IMAP_HOST, port: parsed.MAIL_IMAP_PORT, secure: true },
    smtp: { host: parsed.MAIL_SMTP_HOST, port: parsed.MAIL_SMTP_PORT, secure: true }
  };
}
