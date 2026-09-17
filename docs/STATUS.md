# Creator Outreach Connector Status

Last updated: 2026-09-17

## Current state

The v1 connector implementation is feature-complete for the approved scope and is in final verification.

### Implemented

- Remote MCP HTTP service for ChatGPT custom apps.
- Bearer authentication with constant-time token comparison.
- Host allowlist and bounded JSON request size.
- Alibaba Mail IMAP TLS access.
- Alibaba Mail SMTP TLS sending.
- Mailbox discovery and portable `INBOX` / `SENT` aliases.
- Compact email search results.
- Full email reads with opt-in sanitized HTML.
- RFC thread reconstruction across Inbox and Sent.
- `Reply-To`, `Message-ID`, `In-Reply-To`, and `References` handling.
- Replying from inbound messages and continuing follow-up from previously sent CAMPX messages.
- Individual outbound email sending.
- Separate personalized batch sends with default max 10 / hard max 25.
- Sequential batch throttling and one bounded retry for transient failures.
- Per-item batch results so failed creators can be identified independently.
- Safe error normalization without raw credentials/provider traces.
- Deployment doctor for IMAP/SMTP connectivity and Sent-folder detection.
- Docker non-root production image and health check.
- Production dependency high-severity audit in CI.
- MCP client integration tests for read, send, reply, follow-up, and batch actions.
- Opt-in live IMAP test for a non-production mailbox.
- Opt-in live SMTP send test requiring an owned recipient plus `TEST_MAIL_LIVE_SEND=true`.

## Automated verification gate

Every feature-branch CI run must pass:

1. Unit and integration tests.
2. TypeScript typecheck.
3. Production build.
4. `npm audit --omit=dev --audit-level=high`.
5. Production Docker image build.

## Remaining external verification

These items require credentials/infrastructure and cannot be completed safely in repository-only CI:

- Run `npm run doctor` against the intended Alibaba Mail account using deployment secrets.
- Run opt-in IMAP integration against an owned non-production mailbox.
- Run opt-in SMTP integration to an owned test recipient.
- Deploy the MCP service behind HTTPS.
- Register the deployed `/mcp` endpoint in an eligible ChatGPT workspace and scan the seven tools.
- Perform one owned-inbox end-to-end thread test before contacting real creators.

## Scope intentionally not included in v1

- CRM/dashboard UI.
- Contact database.
- Autonomous negotiation.
- Background campaign scheduler.
- Newsletter-scale bulk sending.
- Automatic unattended follow-ups.
- Production credentials in GitHub Actions.

Follow-up scheduling can be layered on later without changing the core mail connector.
