import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { isAuthorized } from './auth/bearer.js';
import type { ImapMailClient } from './mail/imap-client.js';
import type { SmtpMailClient } from './mail/smtp-client.js';
import { registerMailTools } from './tools/register.js';

export interface HttpAppDependencies {
  authToken: string;
  mailboxAddress: string;
  imap: ImapMailClient;
  smtp: SmtpMailClient;
}

export function createHttpApp(deps: HttpAppDependencies) {
  const handler = createMcpHandler(() => {
    const server = new McpServer(
      { name: 'campx-creator-mail', version: '0.1.0' },
      { capabilities: { tools: {} } }
    );
    registerMailTools(server, deps.imap, deps.smtp, deps.mailboxAddress);
    return server;
  });

  const app = createMcpExpressApp({ host: '0.0.0.0' });

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
