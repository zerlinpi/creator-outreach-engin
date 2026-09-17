import { loadConfig } from './config.js';
import { ImapMailClient } from './mail/imap-client.js';
import { SmtpMailClient } from './mail/smtp-client.js';
import { createHttpApp } from './app.js';

const config = loadConfig();
const imap = new ImapMailClient(config);
const smtp = new SmtpMailClient(config);
const app = createHttpApp({
  authToken: config.authToken,
  mailboxAddress: config.username,
  imap,
  smtp
});

app.listen(config.port, '0.0.0.0', () => {
  console.log(`campx-creator-mail listening on :${config.port}`);
});
