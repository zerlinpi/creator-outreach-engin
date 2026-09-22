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
    baseConfig: config,
    allAccountReadConcurrency: config.allAccountReadConcurrency,
    multiAccountSendConcurrency: config.multiAccountSendConcurrency
  });

  const bindHost = config.bindHost ?? '0.0.0.0';
  const server = app.listen(config.port, bindHost, () => {
    console.log('campx-creator-mail listening on ' + bindHost + ':' + config.port + ' with ' + registry.size + ' mailbox(es)');
  });

  server.on('error', (error) => {
    console.error(error instanceof Error ? error.message : 'HTTP server failed.');
    process.exitCode = 1;
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('campx-creator-mail shutting down after ' + signal + '.');
    const forceExit = setTimeout(() => {
      console.error('Graceful shutdown timed out.');
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    server.close((error) => {
      clearTimeout(forceExit);
      if (error) {
        console.error('HTTP server shutdown failed.');
        process.exitCode = 1;
      }
    });
  };

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Server failed to start.');
  process.exitCode = 1;
});
