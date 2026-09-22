import { loadConfig } from './config.js';
import { createMailAccountRegistry, createMailAccountRuntime } from './mail/accounts.js';
import { EncryptedAccountStore } from './mail/account-store.js';
import { createHttpApp } from './app.js';

async function main() {
  const config = loadConfig();
  const registry = createMailAccountRegistry(config);
  let accountStore: EncryptedAccountStore | undefined;

  if (config.mailAdmin) {
    accountStore = new EncryptedAccountStore(
      config.mailAdmin.storePath,
      config.mailAdmin.storeKey,
      config.mailAdmin.maxAccounts
    );
    const persisted = await accountStore.loadAll(config);
    for (const account of persisted.accounts) {
      if (registry.has(account.id)) {
        throw new Error('Mailbox account id "' + account.id + '" exists in both environment and UI-managed storage.');
      }
      registry.upsert(createMailAccountRuntime(account, 'ui'));
    }
    if (persisted.defaultAccount && registry.has(persisted.defaultAccount)) {
      registry.setDefault(persisted.defaultAccount);
    }
  }

  const app = createHttpApp({
    authToken: config.authToken,
    registry,
    allowedHosts: config.allowedHosts,
    jsonLimit: config.jsonLimit,
    oauth: config.oauth,
    admin: config.mailAdmin,
    accountStore,
    baseConfig: config
  });

  app.listen(config.port, '0.0.0.0', () => {
    console.log('campx-creator-mail listening on :' + config.port + ' with ' + registry.size + ' mailbox(es)');
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Server failed to start.');
  process.exitCode = 1;
});
