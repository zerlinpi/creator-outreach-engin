import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { isAuthorized } from './auth/bearer.js';
import type { ImapMailClient } from './mail/imap-client.js';
import type { SmtpMailClient } from './mail/smtp-client.js';
import { IdempotencyStore } from './mail/idempotency.js';
import { registerMailTools } from './tools/register.js';

export interface HttpAppDependencies {
  authToken: string;
  mailboxAddress: string;
  imap: ImapMailClient;
  smtp: SmtpMailClient;
  allowedHosts?: string[];
  jsonLimit?: string;
  idempotencyStore?: IdempotencyStore;
}

export function createHttpApp(deps: HttpAppDependencies) {
  const idempotency = deps.idempotencyStore ?? new IdempotencyStore();
  const handler = createMcpHandler(() => {
    const server = new McpServer(
      { name: 'campx-creator-mail', version: '0.1.0' },
      { capabilities: { tools: {} } }
    );
    registerMailTools(server, deps.imap, deps.smtp, deps.mailboxAddress, idempotency);
    return server;
  });

  const app = createMcpExpressApp({
    host: '0.0.0.0',
    allowedHosts: deps.allowedHosts,
    jsonLimit: deps.jsonLimit ?? '1mb'
  });

  app.get('/health', (_req, res) => {
    res.status(200).json({ ok: true, service: 'campx-creator-mail' });
  });

  app.use('/mcp', (req, res, next) => {
    if (!isAuthorized(req.header('authorization'), deps.authToken)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  });

  const nodeHandler = toNodeHandler(handler);
  app.all('/mcp', (req, res) => void nodeHandler(req, res, req.body));

  return app;
}
