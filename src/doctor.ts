import { loadConfig } from './config.js';
import { createMailAccountRegistry, createMailAccountRuntime } from './mail/accounts.js';
import { EncryptedAccountStore } from './mail/account-store.js';
import { runMailDiagnostics } from './diagnostics.js';

async function main() {
  const config = loadConfig();
  const registry = createMailAccountRegistry(config);

  if (config.mailAdmin) {
    const store = new EncryptedAccountStore(config.mailAdmin.storePath, config.mailAdmin.storeKey, config.mailAdmin.maxAccounts);
    const persisted = await store.loadAll(config);
    for (const account of persisted.accounts) {
      if (registry.has(account.id)) throw new Error('Duplicate mailbox id across environment and UI storage: ' + account.id);
      registry.upsert(createMailAccountRuntime(account, 'ui'));
    }
    if (persisted.defaultAccount && registry.has(persisted.defaultAccount)) registry.setDefault(persisted.defaultAccount);
  }

  const accounts = [];
  for (const account of registry.list()) {
    const diagnostics = await runMailDiagnostics(account.imap, account.smtp);
    accounts.push({ account: account.id, address: account.address, source: account.source ?? 'environment', ...diagnostics });
  }

  const result = {
    ok: accounts.length > 0 && accounts.every((account) => account.ok),
    defaultAccount: registry.defaultAccountId ?? null,
    accountCount: accounts.length,
    accounts
  };

  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

main().catch(() => {
  console.error(JSON.stringify({
    ok: false,
    error: 'Mail diagnostics could not start. Check mailbox manager storage and environment configuration.'
  }));
  process.exitCode = 1;
});
