# Creator Outreach Connector Status

Last updated: 2026-09-17

## Current state

The v1 connector implementation is feature-complete for the approved scope. Repository-safe single-replica limit/capacity verification is complete; controlled external mailbox/provider verification is next.

### Implemented

- Remote MCP HTTP service for ChatGPT custom apps.
- Bearer authentication with constant-time token comparison.
- Host allowlist and JSON request size constrained to 32 KiB–2 MiB (1 MiB default).
- Alibaba Mail IMAP TLS access.
- Alibaba Mail SMTP TLS sending.
- Mailbox discovery and portable `INBOX` / `SENT` aliases.
- Compact email search results with bounded IMAP source fetches.
- Full email reads with a configured source-size cap and opt-in sanitized HTML.
- IMAP message references bound to mailbox `UIDVALIDITY` so stale UIDs are rejected after mailbox identity changes.
- RFC thread reconstruction across Inbox and Sent with subject/participant fallback when RFC linkage is incomplete.
- Repeated `Re:` / `Fw:` / `Fwd:` prefixes are fully normalized before cross-folder thread lookup.
- `Reply-To`, `Message-ID`, `In-Reply-To`, and `References` handling.
- Replying from inbound messages and continuing follow-up from previously sent CAMPX messages.
- Individual outbound email sending.
- A shared SMTP envelope-recipient cap that also protects generated reply/reply-all messages.
- SMTP sends fail when the primary creator recipient is rejected even if a copied recipient was accepted.
- Separate personalized batch sends with default max 10 / hard max 25.
- Sequential batch throttling; automatic transient retry is disabled by default and can be explicitly enabled for at most one bounded retry.
- Per-item batch results so failed creators can be identified independently.
- Required idempotency keys for real write actions, including result/failure replay protection during the configured TTL.
- Idempotency capacity fails closed rather than evicting unexpired protection records; expired entries are pruned before new capacity is admitted.
- Safe error normalization without raw credentials/provider traces.
- Deployment doctor for IMAP/SMTP connectivity and Sent-folder detection.
- Docker non-root production image and health check, with the Node 22 Alpine base image pinned by digest for reproducible builds.
- Production and full dependency audits in CI at `moderate` severity threshold.
- MCP client integration tests for read, send, reply, follow-up, write-policy, idempotency, and batch actions.
- Opt-in live IMAP test for a non-production mailbox.
- Opt-in live SMTP send test requiring an owned recipient plus `TEST_MAIL_LIVE_SEND=true`.
- Repository-safe limit suite covering 100 concurrent MCP reads, 100 same-key write replays, 100 distinct concurrent writes, 1000-entry idempotency capacity, the 25-message batch ceiling, and JSON-body 413 enforcement.

## Deployment constraint: single replica for v1

The current idempotency store is process-local memory. Its duplicate-send protection is therefore guaranteed only within one running connector process. Until a shared durable idempotency backend is added, production and limit/load testing must run the connector as a **single replica / single process** behind the public endpoint.

Do not horizontally scale the MCP service across multiple replicas behind a load balancer while relying on current idempotency guarantees: the same idempotency key could reach different processes. A process restart also clears the in-memory replay cache, so controlled test sends should use owned recipients and should not be blindly retried with a new key after ambiguous/partial delivery.

## Automated verification gate

Every feature-branch CI run must pass:

1. Unit and integration tests.
2. TypeScript typecheck.
3. Production build.
4. `npm audit --omit=dev --audit-level=moderate`.
5. `npm audit --audit-level=moderate`.
6. Production Docker image build.

## Remaining external verification

These items require credentials/infrastructure and cannot be completed safely in repository-only CI:

- Run `npm run doctor` against the intended Alibaba Mail account using deployment secrets.
- Run opt-in IMAP integration against an owned non-production mailbox.
- Run opt-in SMTP integration to an owned test recipient.
- Deploy the MCP service behind HTTPS as one replica.
- Register the deployed `/mcp` endpoint in an eligible ChatGPT workspace and scan the seven tools.
- Perform one owned-inbox end-to-end thread test before contacting real creators.
- Run controlled provider pacing against owned addresses only (1, 5, 10, then at most 25 messages) and stop on the first provider deferral/rate-limit/timeout anomaly.
- Treat repository mock-limit results as connector correctness evidence, not as an Alibaba Mail quota or throughput SLA.

## Scope intentionally not included in v1

- CRM/dashboard UI.
- Contact database.
- Autonomous negotiation.
- Background campaign scheduler.
- Newsletter-scale bulk sending.
- Automatic unattended follow-ups.
- Shared/distributed idempotency storage.
- Production credentials in GitHub Actions.

Follow-up scheduling and a shared idempotency backend can be layered on later without changing the core mail connector surface.
