import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { loadConfig } from './config.js';
import { isAuthorized } from './auth/bearer.js';
import { ImapMailClient } from './mail/imap-client.js';
import { SmtpMailClient } from './mail/smtp-client.js';
import { registerMailTools } from './tools/register.js';

const config = loadConfig();
const imap = new ImapMailClient(config);
const smtp = new SmtpMailClient(config);

const handler = createMcpHandler(() => {
  const server = new McpServer({ name: 'campx-creator-mail', version: '0.1.0' }, { capabilities: { tools: {} } });
  registerMailTools(server, imap, smtp, config.username);
  return server;
});

const app = createMcpExpressApp({ host: '0.0.0.0' });
app.get('/health', (_req, res) => res.status(200).json({ ok: true, service: 'campx-creator-mail' }));
app.use('/mcp', (req, res, next) => {
  if (!isAuthorized(req.header('authorization'), config.authToken)) return res.status(401).json({ error: 'unauthorized' });
  next();
});
const nodeHandler = toNodeHandler(handler);
app.all('/mcp', (req, res) => void nodeHandler(req, res, req.body));

app.listen(config.port, '0.0.0.0', () => console.log(`campx-creator-mail listening on :${config.port}`));
