import { loadConfig } from './config.js';
import { createMailAccountRegistry } from './mail/accounts.js';
import { runMailDiagnostics } from './diagnostics.js';

async function main() {
  const config = loadConfig();
  const registry = createMailAccountRegistry(config);
  const accounts = [];

  for (const account of registry.list()) {
    const diagnostics = await runMailDiagnostics(account.imap, account.smtp);
    accounts.push({
      account: account.id,
      address: account.address,
      ...diagnostics
    });
  }

  const result = {
    ok: accounts.every((account) => account.ok),
    defaultAccount: registry.defaultAccountId,
    accounts
  };

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
