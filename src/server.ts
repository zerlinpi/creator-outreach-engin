import { loadConfig } from './config.js';
import { createMailAccountRegistry } from './mail/accounts.js';
import { createHttpApp } from './app.js';

const config = loadConfig();
const registry = createMailAccountRegistry(config);
const app = createHttpApp({
  authToken: config.authToken,
  accounts: registry.list(),
  defaultAccount: registry.defaultAccountId,
  allowedHosts: config.allowedHosts,
  jsonLimit: config.jsonLimit,
  oauth: config.oauth
});

app.listen(config.port, '0.0.0.0', () => {
  console.log('creator-outreach-mail listening on :' + config.port);
});
