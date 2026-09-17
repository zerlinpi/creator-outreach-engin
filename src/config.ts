export interface MailEndpointConfig {
  host: string;
  port: number;
  secure: true;
}

export interface AppConfig {
  username: string;
  appPassword: string;
  connectorAuthToken: string;
  fromName: string;
  host: string;
  port: number;
  imap: MailEndpointConfig;
  smtp: MailEndpointConfig;
}

function requireValue(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function parsePort(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${key} must be a valid port`);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${key} must be between 1 and 65535`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    username: requireValue(env, 'MAIL_USERNAME'),
    appPassword: requireValue(env, 'MAIL_APP_PASSWORD'),
    connectorAuthToken: requireValue(env, 'CONNECTOR_AUTH_TOKEN'),
    fromName: env.MAIL_FROM_NAME?.trim() || 'CAMPX',
    host: env.HOST?.trim() || '0.0.0.0',
    port: parsePort(env, 'PORT', 3000),
    imap: {
      host: env.MAIL_IMAP_HOST?.trim() || 'imap.qiye.aliyun.com',
      port: parsePort(env, 'MAIL_IMAP_PORT', 993),
      secure: true,
    },
    smtp: {
      host: env.MAIL_SMTP_HOST?.trim() || 'smtp.qiye.aliyun.com',
      port: parsePort(env, 'MAIL_SMTP_PORT', 465),
      secure: true,
    },
  };
}
