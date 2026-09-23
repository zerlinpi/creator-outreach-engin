import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { hostHeaderValidation } from '@modelcontextprotocol/express';
import express from 'express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { AsyncSemaphore } from './concurrency.js';
import { isAuthorized } from './auth/bearer.js';
import { isOAuthAuthorized, oauthChallenge, registerOAuthRoutes, type OAuthConfig } from './auth/oauth.js';
import type { AppConfig, MailAdminConfig } from './config.js';
import type { ImapMailClient } from './mail/imap-client.js';
import type { SmtpMailClient } from './mail/smtp-client.js';
import { IdempotencyStore, type IdempotencyExecutor } from './mail/idempotency.js';
import { MailAccountRegistry, type MailAccountRuntime } from './mail/accounts.js';
import type { EncryptedAccountStore } from './mail/account-store.js';
import { registerMailboxAdmin } from './admin.js';
import { registerMailTools } from './tools/register.js';

export interface HttpAppDependencies {
  authToken: string;
  registry?: MailAccountRegistry;
  accounts?: MailAccountRuntime[];
  defaultAccount?: string;
  mailboxAddress?: string;
  imap?: ImapMailClient;
  smtp?: SmtpMailClient;
  allowedHosts?: string[];
  jsonLimit?: string;
  oauth?: OAuthConfig;
  idempotencyStore?: IdempotencyExecutor;
  admin?: MailAdminConfig;
  accountStore?: EncryptedAccountStore;
  baseConfig?: AppConfig;
  allAccountReadConcurrency?: number;
  multiAccountSendConcurrency?: number;
}

function buildRegistry(deps: HttpAppDependencies): MailAccountRegistry {
  if (deps.registry) return deps.registry;
  if (deps.accounts) return new MailAccountRegistry(deps.accounts, deps.defaultAccount);
  if (!deps.mailboxAddress || !deps.imap || !deps.smtp) return new MailAccountRegistry();
  return new MailAccountRegistry([{
    id: deps.defaultAccount ?? 'default',
    address: deps.mailboxAddress,
    fromName: 'Default',
    source: 'environment',
    imap: deps.imap,
    smtp: deps.smtp
  }], deps.defaultAccount ?? 'default');
}

export function createHttpApp(deps: HttpAppDependencies) {
  const idempotency = deps.idempotencyStore ?? new IdempotencyStore();
  const registry = buildRegistry(deps);
  const allAccountReadConcurrency = deps.allAccountReadConcurrency ?? 4;
  const multiAccountSendConcurrency = deps.multiAccountSendConcurrency ?? 3;
  const allAccountReadLimiter = new AsyncSemaphore(allAccountReadConcurrency);
  const multiAccountSendLimiter = new AsyncSemaphore(multiAccountSendConcurrency);
  const handler = createMcpHandler(() => {
    const server = new McpServer(
      { name: 'campx-creator-mail', version: '0.3.6' },
      { capabilities: { tools: {} } }
    );
    registerMailTools(server, registry, idempotency, {
      allAccountReadConcurrency,
      multiAccountSendConcurrency,
      allAccountReadLimiter,
      multiAccountSendLimiter
    });
    return server;
  });

  const app = express();
  if (deps.allowedHosts?.length) app.use(hostHeaderValidation(deps.allowedHosts));
  // Trust forwarding headers only when the immediate proxy is loopback (for example local Nginx).
  app.set('trust proxy', 'loopback');

  app.get('/favicon.ico', (_req, res) => {
    res.status(204).end();
  });

  app.get('/health', (_req, res) => {
    res.status(200).json({ ok: true, service: 'campx-creator-mail' });
  });

  app.get('/ready', (_req, res) => {
    const ready = registry.size > 0;
    res.status(ready ? 200 : 503).json({ ok: ready, service: 'campx-creator-mail' });
  });

  if (deps.admin && deps.accountStore && deps.baseConfig) {
    registerMailboxAdmin(app, registry, deps.accountStore, deps.admin, deps.baseConfig);
  }

  if (deps.oauth) registerOAuthRoutes(app, deps.oauth);

  app.use('/mcp', (req, res, next) => {
    const authorization = req.header('authorization');
    if (!isAuthorized(authorization, deps.authToken) && !isOAuthAuthorized(authorization, deps.oauth)) {
      if (deps.oauth) res.setHeader('WWW-Authenticate', oauthChallenge(deps.oauth));
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  });
  // Parse MCP JSON only after authentication so rejected callers cannot force
  // the server to buffer request bodies. OAuth and admin routes use smaller,
  // route-specific parsers.
  app.use('/mcp', express.json({ limit: deps.jsonLimit ?? '1mb' }));

  const nodeHandler = toNodeHandler(handler);
  app.all('/mcp', (req, res) => void nodeHandler(req, res, req.body));

  return app;
}
