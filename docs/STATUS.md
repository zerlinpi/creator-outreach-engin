# Creator Outreach Engine Status

Last updated: 2026-09-23

## Current release target

v0.3.6 is the current production-hardening release for many-mailbox operation. The connector keeps the seven-tool MCP surface while adding a browser Mailbox Manager, fail-closed account isolation, deployment probes, stricter runtime validation, and safer reverse-proxy operation suitable for roughly 10–50 configured mailboxes.

## Implemented and repository-verified

- Dynamic UI-managed mailbox registry with AES-256-GCM credential storage.
- Environment-managed mailbox compatibility.
- Explicit account identity on cross-mailbox read/send results.
- `ACCOUNT_REQUIRED` for ambiguous reads/writes when multiple mailboxes exist.
- `ACCOUNT_MISMATCH` protection for cross-account reply attempts.
- HMAC-signed message refs binding account + mailbox + UIDVALIDITY + UID.
- Gated migration support for unsigned v0.2 refs.
- Bounded all-account IMAP fan-out and configurable per-account IMAP concurrency.
- Bounded multi-account send fan-out and serialized SMTP sends within each account.
- Runtime invalidation when a mailbox is edited or deleted, so queued work does not continue with stale credentials/identity.
- Alibaba/Gmail implicit TLS SMTP plus STARTTLS mode for providers such as Microsoft 365.
- Atomic/serialized Mailbox Manager mutations across encrypted storage and runtime registry.
- Admin no-store/frame-deny/cross-origin-write protections plus failed-auth throttling.
- Authenticated external admin JavaScript with no inline event handlers, no `innerHTML` mailbox rendering, and a stricter script CSP.
- Optional loopback-only connector binding for same-host Nginx deployments plus graceful SIGTERM/SIGINT shutdown.
- Post-deployment probe checks for health/readiness, admin assets, OAuth discovery, MCP auth challenge, and accidental exposure of `.env`, `.git`, package metadata, or encrypted mailbox storage.
- OAuth PKCE, required `mcp:mail` scope, authorization/token throttling, bounded transient state, and rotating refresh tokens with in-process replay rejection.
- Process liveness at `/health` and mailbox readiness at `/ready`.
- Bounded JSON/message/batch/idempotency limits.
- Native deployment preflight validates Node version, project working directory, production config, compiled server, and mailbox-store write permissions.
- Non-root pinned-base Docker image and dependency audits in CI.
- Repository-safe high-water tests for MCP reads, idempotency replays/capacity, batch ceilings, and request-size enforcement.

## Production constraints still in force

The idempotency store is process-local. Production should remain **single replica / single process** until a shared Redis/database-backed idempotency backend is implemented. A restart clears idempotency replay state.

OAuth refresh-token replay tracking is also process-local. Token signatures remain valid across restarts, so durable refresh-token rotation/revocation requires a persistent token-state backend if that becomes a requirement.

Mailbox Manager encrypted storage is file-based and is protected for one process. Persist the configured `MAIL_ACCOUNT_STORE_PATH` (default `./data/mail-accounts.enc.json`) and do not share it writable across multiple processes.

## External verification still required

Repository CI cannot prove provider-specific quotas or real credentials. Before creator outreach:

1. deploy the exact green main commit as one replica behind HTTPS;
2. run `npm run preflight:native` when deploying as native Node.js and confirm the service user can write the configured mailbox-store directory;
3. persist the configured mailbox-store path;
4. run `npm run doctor`;
5. verify `/ready` returns 200;
6. test every configured provider with owned inboxes;
7. search all mailboxes and verify account identity on each result;
8. verify ambiguous sends fail with `ACCOUNT_REQUIRED`;
9. verify intentional cross-account replies fail with `ACCOUNT_MISMATCH`;
10. verify Microsoft 365 accounts with STARTTLS when used;
11. run controlled provider pacing only against owned recipients.

## Next architectural milestone

The highest-value next infrastructure improvement after v0.3 is a shared durable state layer (Redis or database) for idempotency and OAuth refresh-token rotation. That is the prerequisite for safe multi-replica deployment; it is more important than adding more outreach features.
