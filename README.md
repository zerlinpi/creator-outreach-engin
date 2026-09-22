# Creator Outreach Engine

Remote MCP email connector for creator outreach. It is designed to be used directly from ChatGPT, not as a standalone CRM or newsletter platform.

The connector now supports multiple isolated sender mailboxes behind one MCP endpoint. A single ChatGPT app can search, read, send, reply, and batch-send from accounts such as `campx`, `hassky`, or future brands without running one MCP server per mailbox.

## Mailbox Manager UI (recommended)

Version **0.3.0** hardens the browser mailbox manager so the server does not need one environment-variable block per mailbox.

Configure only the admin/encryption secrets:

```env
MAIL_ADMIN_PASSWORD=<strong-password-at-least-16-characters>
MAIL_ACCOUNT_STORE_KEY=<random-secret-at-least-32-characters>
MAIL_ACCOUNT_STORE_PATH=./data/mail-accounts.enc.json
MAIL_MAX_ACCOUNTS=50
```

Then open `https://your-domain/admin` and sign in with username `admin` plus `MAIL_ADMIN_PASSWORD`.

The UI can add, edit, test, and delete mailboxes. In multi-mailbox mode there is deliberately no implicit AI sender selection. UI-managed mailbox passwords are encrypted at rest with AES-256-GCM. Passwords are never returned by the admin API or exposed through MCP tools.

For Docker deployments, persist `/app/data` as a volume so UI-added mailboxes survive container replacement.

Environment-configured mailboxes remain supported and appear as read-only accounts in the UI. Do not configure the same account id in both environment variables and UI storage.


## What it can do

Exactly seven MCP tools are exposed:

- `list_mailboxes` — discover configured mail accounts and their IMAP folders.
- `search_emails` — search one account or all configured accounts; all-account results carry explicit `account` and `accountAddress` source identity.
- `get_email` — read one message by stable connector reference; HTML is opt-in and sanitized.
- `get_thread` — reconstruct a conversation inside one account across Inbox and Sent.
- `send_email` — send one new outreach message from a selected account.
- `reply_email` — reply from the same account that owns the selected message.
- `send_email_batch` — send from one account or explicitly route each message to different accounts; different account groups can run concurrently while each account remains sequential.

The tool count stays fixed as more mailboxes are added. Account selection is a parameter, not a new tool.

## Multi-mailbox model

Recommended production configuration:

```env
MAIL_ACCOUNTS=campx,hassky
MAIL_DEFAULT_ACCOUNT=campx

MAIL_CAMPX_USERNAME=marketing@campxusainc.com
MAIL_CAMPX_APP_PASSWORD=<secret>
MAIL_CAMPX_FROM_NAME=CAMPX

MAIL_HASSKY_USERNAME=marketing@hasskyproducts.com
MAIL_HASSKY_APP_PASSWORD=<secret>
MAIL_HASSKY_FROM_NAME=HASSKY Mobility
```

Account ids must start with a lowercase letter and may contain lowercase letters, numbers, and underscores.

Each account may override its provider endpoints:

```env
MAIL_CAMPX_IMAP_HOST=imap.qiye.aliyun.com
MAIL_CAMPX_IMAP_PORT=993
MAIL_CAMPX_SMTP_HOST=smtp.qiye.aliyun.com
MAIL_CAMPX_SMTP_PORT=465
```

If an override is omitted, the shared `MAIL_IMAP_HOST`, `MAIL_IMAP_PORT`, `MAIL_SMTP_HOST`, and `MAIL_SMTP_PORT` values are used.

### Legacy single-mailbox mode

Existing deployments remain supported. If `MAIL_ACCOUNTS` is not set, the connector uses:

```env
MAIL_USERNAME=
MAIL_APP_PASSWORD=
MAIL_FROM_NAME=CAMPX
```

The legacy account id is `default` unless `MAIL_DEFAULT_ACCOUNT` is supplied.

## Account isolation guarantees

Multi-mailbox routing is intentionally fail-closed:

- New message references are HMAC-signed and bind account + mailbox + UIDVALIDITY + UID. Tampered refs are rejected.
- `get_email`, `get_thread`, and `reply_email` infer the owning account from the message reference.
- If a caller explicitly supplies a different account for an account-scoped message reference, the connector returns `ACCOUNT_MISMATCH`.
- Outbound SMTP `From` identity comes from the selected account only.
- Reply self-address filtering uses the selected account's address.
- Idempotency keys are namespaced by account, so the same business key can safely be used once by `campx` and once by `hassky`.
- Multi-account batch mode requires an explicit `account` on every message and forbids a top-level sender account. Results are labeled with sender account/address, different account groups run concurrently, and each individual account remains sequential.
- Failure of one mailbox does not remove the others from `list_mailboxes`; per-account listing status is returned independently.

This prevents a CAMPX thread from silently being answered by a HASSKY sender identity.

## Tool account behavior

For `search_emails`, `send_email`, and `send_email_batch`:

```json
{
  "account": "hassky"
}
```

is required whenever more than one mailbox is configured. With multiple mailboxes, omitting `account` returns `ACCOUNT_REQUIRED` instead of guessing a sender.

For `get_email`, `get_thread`, and `reply_email`, new message references select the account automatically. Supplying `account` is optional and acts as an additional safety check.

`list_mailboxes` with no account returns all configured accounts. With an account argument it inspects only that account. When the user asks to check every mailbox, call `search_emails` with `all_accounts=true`; partial mailbox failures are returned separately and do not erase successful results.

## Write safety

Write tools use idempotency keys so retried MCP requests do not silently duplicate a send. Reusing the same key with a different payload in the same account is rejected as `IDEMPOTENCY_CONFLICT`.

Completed results are cached for 15 minutes by default and the in-memory cache is bounded. The idempotency store is still process-local, so production should run as a single Node process / single replica until a shared Redis or database-backed store is added.

## Batch sending safeguards

Batch default is 10 messages and the hard maximum is 25 per invocation. Delivery is sequential.

`send_email_batch` supports:

- `account` — sender account; required in multi-mailbox single-sender mode.
- `dry_run` — validate and preview without sending or consuming an idempotency key.
- `idempotency_key` — required for a real send.
- `delay_ms` — 0–5000 ms between messages; default 250.
- `retry_transient` — retry one temporary provider/network failure; default false.
- `retry_delay_ms` — 0–10000 ms before the optional retry; default 1000.
- `allow_duplicates` — default false; duplicate recipient + subject pairs are rejected.

The connector rejects batch timing configurations whose worst-case configured wait exceeds 60 seconds.

## Alibaba Mail setup

Use a dedicated third-party/app password for every mailbox when available. Never commit mailbox passwords, app passwords, connector tokens, OAuth secrets, or a populated `.env`.

```bash
cp .env.example .env
```

Shared Alibaba defaults:

- IMAP: `imap.qiye.aliyun.com:993`
- SMTP: `smtp.qiye.aliyun.com:465`

Resource defaults:

- `MAIL_CONNECTION_TIMEOUT_MS=15000`
- `MAIL_GREETING_TIMEOUT_MS=10000`
- `MAIL_SOCKET_TIMEOUT_MS=30000`
- `MAIL_MAX_MESSAGE_BYTES=10485760`
- `MAIL_SEARCH_SOURCE_BYTES=131072`
- `MAIL_IMAP_ACCOUNT_CONCURRENCY=2`
- `MAIL_ALL_ACCOUNT_READ_CONCURRENCY=4`
- `MAIL_MULTI_ACCOUNT_SEND_CONCURRENCY=3`

`MAIL_SEARCH_SOURCE_BYTES` is independently capped at 512 KiB and must not exceed `MAIL_MAX_MESSAGE_BYTES`. Cross-account reads and sends are bounded; each account also serializes SMTP sends. Set `MAIL_SMTP_SECURITY=starttls` for providers such as Microsoft 365 that use port 587.

### Keep SMTP mail in Sent

For thread lookup and follow-up history, configure the provider to keep client-sent SMTP messages in the server-side Sent folder. The connector discovers the Sent folder using IMAP `\\Sent` special-use metadata and common fallbacks.

Portable mailbox aliases such as `INBOX` and `SENT` are supported.

## Runtime security

Required connector secret:

```env
CONNECTOR_AUTH_TOKEN=<at-least-32-characters>
# Recommended if CONNECTOR_AUTH_TOKEN may rotate:
MAIL_MESSAGE_REF_SIGNING_KEY=<independent-random-secret-at-least-32-characters>
```

Production also requires `CONNECTOR_ALLOWED_HOSTS`.

Example:

```env
NODE_ENV=production
CONNECTOR_ALLOWED_HOSTS=domail.campxusainc.com,127.0.0.1
```

Do not include schemes, ports, paths, or wildcards. `CONNECTOR_JSON_LIMIT` defaults to `1mb` and is restricted to 32 KiB–2 MiB.

`GET /health` reports process liveness only. `GET /ready` returns 200 only when at least one mailbox is configured; neither endpoint exposes mailbox credentials or message data.

## ChatGPT OAuth

To connect the MCP endpoint as a ChatGPT custom app using OAuth, configure all three values together:

```env
OAUTH_ISSUER=https://domail.campxusainc.com
OAUTH_LOGIN_PASSWORD=<separate-strong-password>
OAUTH_SIGNING_SECRET=<random-secret-at-least-32-characters>
```

The connector exposes:

- `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-protected-resource/mcp`
- `/.well-known/oauth-authorization-server`
- `/oauth/register`
- `/oauth/authorize`
- `/oauth/token`

It uses Authorization Code + PKCE S256, dynamic public-client registration, one-time authorization codes, one-hour access tokens, rotating 30-day refresh tokens with in-process replay rejection, failure rate limits, and `offline_access`. MCP access requires the `mcp:mail` scope.

The static `CONNECTOR_AUTH_TOKEN` remains valid as an operator/compatibility credential.

Before registering ChatGPT:

```bash
curl -i https://domail.campxusainc.com/.well-known/oauth-protected-resource
curl -i https://domail.campxusainc.com/.well-known/oauth-authorization-server
curl -i -X POST https://domail.campxusainc.com/mcp -H 'Content-Type: application/json' -d '{}'
```

The discovery endpoints should return HTTP 200. The unauthenticated MCP request should return HTTP 401 with a `WWW-Authenticate` challenge.

## Run locally

```bash
npm ci
npm test
npm run typecheck
npm run build
npm start
```

Endpoints:

- Liveness: `GET /health`
- Readiness: `GET /ready`
- MCP: `/mcp`

## Mail doctor

Run:

```bash
npm run doctor
```

The doctor checks every configured account separately:

- IMAP authentication.
- folder listing.
- Sent-folder discovery.
- SMTP authentication/connectivity.

It does not send mail. Output contains safe account ids/addresses and check status, not passwords or raw provider errors. The command exits non-zero if any configured account is not ready.

## Opt-in live integration tests

Normal CI never logs into production mailboxes and never sends live mail.

Owned test mailbox IMAP:

```bash
TEST_MAIL_USERNAME=test-mailbox@example.com \
TEST_MAIL_APP_PASSWORD=... \
npm run test:integration
```

Owned-recipient SMTP:

```bash
TEST_MAIL_USERNAME=test-mailbox@example.com \
TEST_MAIL_APP_PASSWORD=... \
TEST_MAIL_RECIPIENT=owned-test-inbox@example.com \
TEST_MAIL_LIVE_SEND=true \
npm run test:integration
```

Optional provider overrides:

- `TEST_MAIL_IMAP_HOST`
- `TEST_MAIL_IMAP_PORT`
- `TEST_MAIL_SMTP_HOST`
- `TEST_MAIL_SMTP_PORT`

### Controlled provider pacing

After one owned-recipient SMTP test passes, use the opt-in pacing harness. It permits only 1–25 messages with a 250–5000 ms delay.

```bash
TEST_MAIL_USERNAME=test-mailbox@example.com \
TEST_MAIL_APP_PASSWORD=... \
TEST_MAIL_RECIPIENT=owned-test-inbox@example.com \
TEST_MAIL_LIVE_PACING=true \
TEST_MAIL_PACING_COUNT=1 \
TEST_MAIL_PACING_DELAY_MS=500 \
npm run test:provider-pacing
```

Increase only through 1 → 5 → 10 → 25 after each previous run is clean.

## CI verification

GitHub Actions runs:

```bash
npm ci
npm test
npm run typecheck
npm run build
npm audit --omit=dev --audit-level=moderate
npm audit --audit-level=moderate
docker build -t creator-outreach-engine:ci .
```

CI runs on pushes to `main`, pull requests targeting `main`, and manual workflow dispatch.

## Typical ChatGPT prompts

- `查看 campx 最近有没有红人回复。`
- `查看 hassky 和 creator@example.com 的完整邮件线程。`
- `用 campx 回复这一封邮件。`
- `用 hassky 给 creator@example.com 发一封邮件。`
- `用 campx 给这 8 个红人分别发送下面的邮件，每个人独立一封。`
- `先对 hassky 这 10 封邮件 dry-run，不发送。`

Email bodies returned by read tools are marked as external/untrusted content. Search results are compact; full HTML is returned only when explicitly requested.

## Deployment

Deploy as a Node.js 22 service or Docker container with outbound access to the configured IMAP and SMTP endpoints.

Inject secrets through the hosting platform. Never bake a populated `.env` into the image.

For non-Docker production deployments, set `NODE_ENV=production`. The public MCP endpoint must be HTTPS.

Current production guidance remains single process / single replica because idempotency state is in memory.

## Verification before real outreach

Before contacting creators:

1. Confirm CI is green on the exact commit being deployed.
2. Run `npm run doctor` and confirm every configured account passes.
3. Run opt-in IMAP/SMTP tests with owned non-production addresses.
4. Call `list_mailboxes` and confirm all account ids and sender addresses are correct.
5. Search each account independently.
6. Verify a new message reference from each account returns the correct `account`.
7. Try an intentional cross-account reply mismatch and confirm `ACCOUNT_MISMATCH`.
8. Send one idempotent test email from each account using the same idempotency key and confirm one delivery per account.
9. Verify replies preserve thread headers and use the owning sender account.
10. Dry-run and then send a small batch from each account independently.
11. Confirm SMTP client messages appear in the correct provider Sent folder.
12. Register `/mcp` in ChatGPT and repeat the owned-inbox end-to-end flow before creator outreach.

## Non-goals

The connector is intentionally not:

- a newsletter sender,
- a full CRM,
- an autonomous negotiation agent,
- an automatic sender-account rotation system,
- a failover system that silently switches brands when one mailbox fails.

Sender identity must remain explicit and predictable.
