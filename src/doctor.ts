import { loadConfig } from './config.js';
import { ImapMailClient } from './mail/imap-client.js';
import { SmtpMailClient } from './mail/smtp-client.js';
import { runMailDiagnostics } from './diagnostics.js';

async function main() {
  const config = loadConfig();
  const imap = new ImapMailClient(config);
  const smtp = new SmtpMailClient(config);
  const result = await runMailDiagnostics(imap, smtp);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

main().catch(() => {
  console.error(JSON.stringify({
    ok: false,
    error: 'Mail diagnostics could not start. Check required environment configuration and try again.'
  }));
  process.exitCode = 1;
});
