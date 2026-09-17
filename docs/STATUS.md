# Creator Outreach Connector Status

Last updated: 2026-09-17

## Current state

The v1 connector implementation is feature-complete for the approved scope and is in final verification before limit/load testing.

### Implemented

- Remote MCP HTTP service for ChatGPT custom apps.
- Bearer authentication with constant-time token comparison.
- Host allowlist and bounded JSON request size.
- Alibaba Mail IMAP TLS access.
- Alibaba Mail SMTP TLS sending.
- Mailbox discovery and portable `INBOX` / `SENT` aliases.
- Compact email search results with bounded IMAP source fetches.
- Full email reads with a configured source-size cap and opt-in sanitized HTML.
- IMAP message references bound to mailbox `UIDVALIDITY` so stale UIDs are rejected after mailbox identity changes.
- RFC thread reconstruction across Inbox and Sent with subject/participant fallback when RFC linkage is incomplete.
- `Reply-To`, `Message-ID`, `In-Reply-To`, and `References` handling.
- Replying from inbound messages and continuing follow-up from previously sent CAMPX messages.
- Individual outbound email sending.
- A shared SMTP envelope-recipient cap that also protects generated reply/reply-all messages.
- Separate personalized batch sends with default max 10 / hard max 25.
- Sequential batch throttling; automatic transient retry is disabled by default and can be explicitly enabled for at most one bounded retry.
- Per-item batch results so failed creators can be identified independently.
- Required idempotency keys for real write actions, including result/failure replay protection during the configured TTL.
- Idempotency capacity fails closed rather than evicting unexpired protection records; expired entries are pruned before new capacity is admitted.
- Safe error normalization without raw credentials/provider traces.
- Deployment doctor for IMAP/SMTP connectivity and Sent-folder detection.
- Docker non-root production image and health check.
- Production and full dependency audits in CI at `moderate` severity threshold.
- MCP client integration tests for read, send, reply, follow-up, write-policy, idempotency, and batch actions.
- Opt-in live IMAP test for a non-production mailbox.
- Opt-in live SMTP send test requiring an owned recipient plus `TEST_MAIL_LIVE_SEND=true`.

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
- Deploy the MCP service behind HTTPS.
- Register the deployed `/mcp` endpoint in an eligible ChatGPT workspace and scan the seven tools.
- Perform one owned-inbox end-to-end thread test before contacting real creators.
- Perform bounded limit/load testing only after the pre-limit code audit is merged and `main` is green.

## Scope intentionally not included in v1

- CRM/dashboard UI.
- Contact database.
- Autonomous negotiation.
- Background campaign scheduler.
- Newsletter-scale bulk sending.
- Automatic unattended follow-ups.
- Production credentials in GitHub Actions.

Follow-up scheduling can be layered on later without changing the core mail connector.
