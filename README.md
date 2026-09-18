# Creator Outreach Engine

Remote MCP mail connector for CAMPX creator outreach. It is designed to be called directly from a ChatGPT conversation, not used as a standalone CRM or campaign dashboard.

## Capabilities

Seven MCP tools are exposed:

- `list_mailboxes` — list IMAP folders and special-use roles.
- `search_emails` — compact search results by sender, recipient, subject, date, unread state, mailbox, or body text.
- `get_email` — read one message by stable connector reference; HTML is opt-in and sanitized.
- `get_thread` — reconstruct a conversation across Inbox and the provider-designated Sent folder.
- `send_email` — send one new outreach message.
- `reply_email` — reply to inbound or previously sent messages while preserving RFC thread headers.
- `send_email_batch` — dry-run or send separate personalized messages to multiple creators; never converts the list into a CC/BCC blast.

Write tools use idempotency keys so a retried MCP request does not silently duplicate a send. Reusing the same key with a different payload is rejected as `IDEMPOTENCY_CONFLICT`. Completed results are cached for 15 minutes by default and the in-memory cache is bounded.

## Batch sending safeguards

Batch default is 10 messages and the hard maximum is 25 per tool invocation. Delivery is sequential rather than concurrent.

`send_email_batch` supports:

- `dry_run` — validate and preview recipients/subjects without sending and without consuming an idempotency key.
- `idempotency_key` — required for a real batch send.
- `delay_ms` — 0–5000 ms between separate creator messages; default 250.
- `retry_transient` — retry one temporary provider/network failure; default **false** to avoid ambiguous duplicate delivery.
- `retry_delay_ms` — 0–10000 ms before the optional retry; default 1000.
- `allow_duplicates` — default false; duplicate recipient + subject pairs in one batch are rejected.

The connector rejects batch timing configurations whose worst-case configured wait exceeds 60 seconds. These controls are for small creator-outreach batches, not newsletter-scale sending.

## Alibaba Mail setup

Use a dedicated Alibaba Mail third-party client/app password when available. Never commit mailbox passwords, app passwords, or connector tokens.

```bash
cp .env.example .env
```

Required values:

- `MAIL_USERNAME` — full CAMPX enterprise email address.
- `MAIL_APP_PASSWORD` — Alibaba Mail third-party/app password.
- `CONNECTOR_AUTH_TOKEN` — random bearer token with at least **32 characters**.

Production deployments should also set:

- `NODE_ENV=production`
- `CONNECTOR_ALLOWED_HOSTS` — every hostname legitimately used by the reverse proxy/deployment plus loopback when needed for health checks.

TLS defaults:

- IMAP: `imap.qiye.aliyun.com:993`
- SMTP: `smtp.qiye.aliyun.com:465`

Bounded mail-resource defaults:

- `MAIL_CONNECTION_TIMEOUT_MS=15000`
- `MAIL_GREETING_TIMEOUT_MS=10000`
- `MAIL_SOCKET_TIMEOUT_MS=30000`
- `MAIL_MAX_MESSAGE_BYTES=10485760` (10 MiB full-message cap)
- `MAIL_SEARCH_SOURCE_BYTES=131072` (128 KiB search-result source cap)

`MAIL_SEARCH_SOURCE_BYTES` must not exceed `MAIL_MAX_MESSAGE_BYTES`. Search results indicate when source content was truncated; `get_email` rejects full messages that exceed the configured full-message cap.

### Keep client-sent mail in Sent

For thread lookup and follow-up history, Alibaba Mail should save SMTP client messages to the server-side Sent folder. In Alibaba Webmail, check the sending settings and use a rule that saves client-sent messages (for example **Save all**). The connector discovers the Sent folder using IMAP `\\Sent` special-use metadata and falls back to common Sent folder names.

`search_emails` accepts portable mailbox aliases such as `INBOX` and `SENT`; `SENT` is resolved to the provider-designated Sent folder, so ChatGPT does not need to guess localized folder names such as `已发送` or `Sent Messages`.

## Runtime security

`CONNECTOR_ALLOWED_HOSTS` is a comma-separated hostname allowlist used by the MCP HTTP server for Host-header validation when binding to `0.0.0.0`.

Local example:

```env
CONNECTOR_ALLOWED_HOSTS=localhost,127.0.0.1
```

Production example:

```env
NODE_ENV=production
CONNECTOR_ALLOWED_HOSTS=mail-mcp.example.com,127.0.0.1
```

Do not include schemes, ports, paths, or wildcards. In production mode the connector refuses to start without an allowlist. Keep `127.0.0.1` when using the included Docker `HEALTHCHECK`, because the container checks `/health` through loopback.

`CONNECTOR_JSON_LIMIT` defaults to `1mb`, enough for normal creator outreach and small batch requests while keeping MCP request bodies bounded.

All `/mcp` requests require:

```http
Authorization: Bearer <CONNECTOR_AUTH_TOKEN>
```

`GET /health` returns process health only and never mailbox data or secrets.

## Run locally

```bash
npm ci
npm test
npm run typecheck
npm run build
MAIL_USERNAME=... \
MAIL_APP_PASSWORD=... \
CONNECTOR_AUTH_TOKEN=... \
CONNECTOR_ALLOWED_HOSTS=localhost,127.0.0.1 \
npm start
```

Endpoints:

- Health: `GET /health`
- MCP: `/mcp`

## Mail doctor

Before exposing the MCP endpoint to ChatGPT, run the deployment diagnostic with the real mailbox secrets injected through your shell or hosting platform:

```bash
MAIL_USERNAME=... \
MAIL_APP_PASSWORD=... \
CONNECTOR_AUTH_TOKEN=... \
CONNECTOR_ALLOWED_HOSTS=localhost,127.0.0.1 \
npm run doctor
```

The doctor does **not** send an email. It verifies that:

- IMAP authentication succeeds.
- mailbox folders can be listed.
- a usable Sent folder can be identified.
- SMTP authentication/connectivity succeeds.

It prints only safe status data such as mailbox count and the resolved Sent folder. Passwords and raw provider errors are intentionally not included. A non-zero process exit code means deployment should not proceed until the failing check is fixed.

## Opt-in live integration tests

The normal CI suite never logs into CAMPX production mail and never sends live email. Two opt-in integration tests are included for an **owned, non-production test mailbox**.

IMAP verification:

```bash
TEST_MAIL_USERNAME=test-mailbox@example.com \
TEST_MAIL_APP_PASSWORD=... \
npm run test:integration
```

This verifies TLS login, folder listing, Inbox search, and message fetch when a message exists.

SMTP live sending requires an additional owned recipient and an explicit send switch:

```bash
TEST_MAIL_USERNAME=test-mailbox@example.com \
TEST_MAIL_APP_PASSWORD=... \
TEST_MAIL_RECIPIENT=owned-test-inbox@example.com \
TEST_MAIL_LIVE_SEND=true \
npm run test:integration
```

Optional provider overrides are available as `TEST_MAIL_IMAP_HOST`, `TEST_MAIL_IMAP_PORT`, `TEST_MAIL_SMTP_HOST`, and `TEST_MAIL_SMTP_PORT`. Do not point these tests at the CAMPX production mailbox in CI.

### Controlled provider pacing

After the one-message owned-recipient SMTP test passes, a separate explicit pacing harness can validate small sequential provider runs. It is disabled unless `TEST_MAIL_LIVE_PACING=true` is supplied and it enforces 1–25 messages with a 250–5000 ms delay.

Start with one owned-recipient message:

```bash
TEST_MAIL_USERNAME=test-mailbox@example.com \\
TEST_MAIL_APP_PASSWORD=... \\
TEST_MAIL_RECIPIENT=owned-test-inbox@example.com \\
TEST_MAIL_LIVE_PACING=true \\
TEST_MAIL_PACING_COUNT=1 \\
TEST_MAIL_PACING_DELAY_MS=500 \\
npm run test:provider-pacing
```

Only move to counts 5, 10, and then at most 25 when the previous run is clean. This harness must never use creator addresses and is never enabled by CI.

## CI verification

GitHub Actions verifies the repository with the locked dependency graph and Node.js 22.23.2:

```bash
npm ci
npm test
npm run typecheck
npm run build
npm audit --omit=dev --audit-level=moderate
npm audit --audit-level=moderate
docker build -t creator-outreach-engine:ci .
```

CI runs on pushes to `main`, pull requests targeting `main`, and can also be started manually with `workflow_dispatch`.

## Typical ChatGPT prompts

- `查一下 Happily Ever Hanks 最近有没有回复 CAMPX。`
- `把我们和 creator@example.com 最近的完整邮件线程给我。`
- `回复这一封，告诉他我们的常规佣金是 8%，最高可以谈到 10%，量大可以另外谈。`
- `给这 8 个红人分别发送下面的邮件，每个人独立一封。`
- `先 dry-run 检查这 10 个红人的收件人和主题，不发送邮件。`
- `给这 10 个红人分别发送首封邮件，间隔 500ms；不要自动重试。`
- `这批邮件允许临时失败重试一次，retry_transient=true。`

Email bodies returned by read tools are marked as external/untrusted content. Search results return only short previews; full HTML is not returned unless explicitly requested.

## Deployment

Deploy as a Node.js 22 service or Docker container with outbound TCP access to:

- IMAP 993
- SMTP 465

Inject secrets using the hosting platform's secret manager. Never bake `.env` into the image.

For a non-Docker production deployment, explicitly set `NODE_ENV=production`; the Docker image already sets it. The public MCP endpoint must be HTTPS. Configure `CONNECTOR_ALLOWED_HOSTS` with the deployed hostname plus any legitimate proxy/health-check hosts before enabling the connector.

## Connect to ChatGPT

ChatGPT custom apps use a remote MCP endpoint. In a workspace that supports custom MCP apps, create a custom app, provide the deployed HTTPS `/mcp` endpoint, configure a supported authentication mechanism, scan the exposed tools, and test the draft app before publishing it to the workspace.

Write/modify MCP actions such as `send_email`, `reply_email`, and `send_email_batch` depend on the ChatGPT workspace plan and permissions. The mail connector itself exposes both read and write tools; the ChatGPT workspace controls which actions are allowed and when confirmation is required.

## Verification before real outreach

Before contacting creators, use owned test addresses and verify the complete loop:

1. Confirm the repository CI is green on the exact commit being deployed.
2. Run `npm run doctor` and confirm all checks pass.
3. Run the opt-in IMAP integration test with a non-production mailbox.
4. Run the opt-in SMTP integration test only with an owned recipient and `TEST_MAIL_LIVE_SEND=true`.
5. Confirm `search_emails` can find a test message and exposes truncation state when applicable.
6. Confirm `get_email` returns the expected text and headers.
7. Dry-run a batch and verify recipients/subjects before sending.
8. Send one idempotent test email to an owned inbox, then replay the same idempotency key and confirm no duplicate delivery.
9. Reply from the owned inbox and confirm `get_thread` shows inbound and outbound messages together.
10. Confirm `reply_email` stays in the same normal mail-client thread.
11. Confirm `send_email_batch` sends separate messages to multiple owned inboxes.
12. Explicitly enable `retry_transient=true` in a controlled test and confirm at most one bounded retry occurs.
13. Confirm SMTP client messages appear in Alibaba Mail Sent.
14. Deploy behind HTTPS, register `/mcp` in ChatGPT, scan all seven tools, and repeat the owned-inbox end-to-end test before creator outreach.

## Safety and behavior

- Credentials are loaded only from runtime environment/secrets.
- Production message bodies are not intentionally logged.
- Search output is compact and bounded to reduce unnecessary mailbox exposure.
- Full message reads have a configurable byte cap.
- HTML is opt-in and sanitized before tool output.
- Batch recipients are validated before the first send.
- Duplicate recipient + subject pairs are rejected by default within one batch.
- Batch sends are sequential and throttled rather than fired concurrently.
- Automatic transient retry is disabled by default; when explicitly enabled, at most one bounded retry is attempted.
- Permanent recipient failures are not retried.
- Real write operations require idempotency keys; conflicting key reuse is rejected.
- Replies honor `Reply-To` when present and preserve `Message-ID`, `In-Reply-To`, and `References` when available.
- Replying from a previously sent CAMPX message correctly targets the original creator recipients.
- The connector is intentionally not a newsletter sender, CRM, or autonomous negotiation agent.
