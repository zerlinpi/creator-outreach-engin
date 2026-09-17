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
- `send_email_batch` — send separate personalized messages to multiple creators; never converts the list into a CC/BCC blast.

Batch default is 10 messages and the hard maximum is 25 per tool invocation.

## Alibaba Mail setup

Use a dedicated Alibaba Mail third-party client/app password when available. Never commit the mailbox password or connector token.

```bash
cp .env.example .env
```

Required values:

- `MAIL_USERNAME` — full CAMPX enterprise email address.
- `MAIL_APP_PASSWORD` — Alibaba Mail third-party/app password.
- `CONNECTOR_AUTH_TOKEN` — random bearer token with at least 16 characters.

TLS defaults:

- IMAP: `imap.qiye.aliyun.com:993`
- SMTP: `smtp.qiye.aliyun.com:465`

### Important: keep client-sent mail in Sent

For thread lookup and follow-up history, Alibaba Mail should save SMTP client messages to the server-side Sent folder. In Alibaba Webmail, check the sending settings and use a rule that saves client-sent messages (for example **Save all**). The connector discovers the Sent folder using IMAP `\\Sent` special-use metadata and falls back to common Sent folder names.

## Runtime security

`CONNECTOR_ALLOWED_HOSTS` is a comma-separated hostname allowlist used by the MCP HTTP server for Host-header validation when binding to `0.0.0.0`.

Local example:

```env
CONNECTOR_ALLOWED_HOSTS=localhost,127.0.0.1
```

Production example:

```env
CONNECTOR_ALLOWED_HOSTS=mail-mcp.example.com
```

Do not include schemes or ports. Add every hostname your reverse proxy or deployment platform legitimately uses.

`CONNECTOR_JSON_LIMIT` defaults to `1mb`, enough for normal creator outreach and batch requests while still placing a bound on MCP request bodies.

All `/mcp` requests also require:

```http
Authorization: Bearer <CONNECTOR_AUTH_TOKEN>
```

`GET /health` returns process health only and never mailbox data or secrets.

## Run locally

```bash
npm install
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

## Typical ChatGPT prompts

- `查一下 Happily Ever Hanks 最近有没有回复 CAMPX。`
- `把我们和 creator@example.com 最近的完整邮件线程给我。`
- `回复这一封，告诉他我们的常规佣金是 8%，最高可以谈到 10%，量大可以另外谈。`
- `给这 8 个红人分别发送下面的邮件，每个人独立一封。`
- `打开我们上一封已发送邮件，继续跟进这个红人。`

Email bodies returned by read tools are marked as external/untrusted content. Search results return only short previews; full HTML is not returned unless explicitly requested.

## Deployment

Deploy as a Node.js 22 service or Docker container with outbound TCP access to:

- IMAP 993
- SMTP 465

Inject secrets using the hosting platform's secret manager. Never bake `.env` into the image.

The public MCP endpoint must be HTTPS for ChatGPT. Configure `CONNECTOR_ALLOWED_HOSTS` with the deployed hostname before enabling the connector.

## Connect to ChatGPT

ChatGPT custom apps use a remote MCP endpoint. In a workspace that supports custom MCP apps, create a custom app, provide the deployed HTTPS `/mcp` endpoint, configure authentication, scan the exposed tools, and test the draft app before publishing it to the workspace.

Write/modify MCP actions such as `send_email`, `reply_email`, and `send_email_batch` depend on the ChatGPT workspace plan and permissions. The mail connector itself exposes both read and write tools; the ChatGPT workspace controls which actions are allowed and when confirmation is required.

## Verification before real outreach

Before contacting creators, use an owned test inbox and verify the complete loop:

1. `search_emails` can find a test message.
2. `get_email` returns the expected text and headers.
3. `send_email` arrives at the owned test inbox.
4. Reply from the owned inbox.
5. `get_thread` shows inbound and outbound messages together.
6. `reply_email` remains in the same normal mail-client thread.
7. `send_email_batch` sends separate messages to multiple owned inboxes.
8. Confirm SMTP client messages appear in Alibaba Mail Sent.

## Safety and behavior

- Credentials are loaded only from runtime environment/secrets.
- Production message bodies are not intentionally logged.
- Search output is compact to reduce unnecessary mailbox exposure.
- HTML is opt-in and sanitized before tool output.
- Batch recipients are validated before the first send.
- Duplicate recipient + subject pairs are rejected by default within one batch.
- Replies preserve `Message-ID`, `In-Reply-To`, and `References` when available.
- Replying from a previously sent CAMPX message correctly targets the original creator recipients.
- No database, autonomous negotiation, automatic scheduler, or standalone CRM is included in v1.
