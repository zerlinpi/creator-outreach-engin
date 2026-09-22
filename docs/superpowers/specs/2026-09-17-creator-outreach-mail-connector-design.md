# Creator Outreach Mail Connector — Design

> Historical note: this is the original v0.1 single-mailbox design. Multi-mailbox routing and the Mailbox Manager implemented later supersede its single-CAMPX and “multi-mailbox out of scope” assumptions. See `docs/MAILBOX_MANAGER.md` and `docs/MULTI_MAILBOX.md` for current behavior.

Date: 2026-09-17
Repository: `zerlinpi/creator-outreach-engin`
Status: Proposed for implementation

## 1. Goal

Build a lightweight remote MCP mail connector that can be invoked directly from an existing ChatGPT conversation, with an experience similar to a mail app connector: search CAMPX mail, read incoming replies, inspect the full conversation thread, send a new outreach email, and reply inside the existing thread.

This repository is **not** a CRM, dashboard, campaign manager, or standalone outreach product. Its job is to expose a small, reliable set of mail actions to ChatGPT.

The connector must also support future requests such as “send these personalized messages to these 12 creators” without forcing the user to leave the chat window.

## 2. Scope

### In scope

- One CAMPX Alibaba Cloud enterprise mailbox for v1.
- Read mail over IMAP with TLS.
- Send mail over SMTP with TLS.
- Search mail by sender, recipient, subject, mailbox, date range, and unread status.
- Read a single message with normalized text, HTML metadata, headers, attachments metadata, and stable message identifiers.
- Reconstruct a thread using RFC message identifiers and conservative fallbacks.
- Send a new message.
- Reply to a message while preserving `Message-ID`, `In-Reply-To`, `References`, and subject threading semantics.
- Send multiple creator outreach messages in one ChatGPT action as separate individual emails.
- Return per-recipient send results to ChatGPT.
- Keep credentials entirely outside Git.
- Expose the connector as a remote MCP endpoint suitable for a ChatGPT custom app when the target ChatGPT workspace permits the required read/write actions.

### Out of scope for v1

- CRM UI or web dashboard.
- Contact database.
- Automatic negotiation or autonomous reply generation.
- Calendar, social media, or affiliate platform integration.
- Mass-newsletter behavior, CC/BCC blasts, list management, or marketing automation journeys.
- Persistent campaign scheduling.
- Automatic follow-up timers. ChatGPT can read the latest thread and send follow-ups when explicitly requested; scheduled follow-up is a later connector capability if needed.
- Multi-mailbox account switching.

## 3. User experience

Expected chat interactions:

- “查一下 Happily Ever Hanks 最近有没有回 CAMPX。”
- “把我们和 `creator@example.com` 的完整往来给我。”
- “回复这一封，告诉他我们通常是 8%，最高可以谈到 10%，量大可以另外谈。”
- “给这 8 个红人分别发送下面的合作邮件，名字和频道信息按各自资料替换。”
- “只给还没回复的人发第二封 follow-up。”

For write actions, the connector exposes clear inputs and returns the exact recipients, subject, server acceptance status, and generated message ID so ChatGPT can present a final confirmation to the user.

## 4. Architecture

```text
ChatGPT conversation
        |
        | MCP over HTTPS
        v
Remote MCP Server
        |
        +-- tool layer
        |    +-- search_emails
        |    +-- get_email
        |    +-- get_thread
        |    +-- list_mailboxes
        |    +-- send_email
        |    +-- reply_email
        |    +-- send_email_batch
        |
        +-- mail service
             +-- IMAP client
             +-- SMTP client
             +-- MIME parser
             +-- thread resolver
             +-- address/header validator
```

Implementation language: TypeScript on Node.js.

The code is split into small modules so transport, IMAP, SMTP, parsing, and threading can be tested independently.

## 5. MCP tools

### `list_mailboxes`

Read-only. Returns available folders/mailboxes, normalized special-use role when detectable, and message counts when inexpensive.

### `search_emails`

Read-only.

Inputs:

- `query?`: free-text search over supported IMAP fields.
- `from?`
- `to?`
- `subject?`
- `mailbox?`
- `unread?`
- `since?`
- `before?`
- `limit?` — default 20, hard max 100.

Returns compact summaries with stable connector IDs, sender, recipients, subject, sent date, unread state, and RFC `Message-ID` when available.

### `get_email`

Read-only.

Input: stable connector message ID.

Returns:

- envelope fields
- RFC `Message-ID`
- `In-Reply-To`
- `References`
- normalized plain-text body
- sanitized HTML body only when needed
- attachment metadata, not arbitrary attachment bytes in v1
- mailbox and IMAP UID metadata required for later reply/thread operations

### `get_thread`

Read-only.

Inputs:

- connector message ID, or
- participant email plus optional subject hint.

Primary grouping uses `Message-ID` / `In-Reply-To` / `References`. If identifiers are missing, fallback grouping may use normalized subject + participants + bounded date window and must mark the result as heuristic.

Returns messages oldest-to-newest.

### `send_email`

Write action.

Inputs:

- `to`: one or more validated email addresses
- `cc?`
- `bcc?`
- `subject`
- `text`
- `html?`
- `reply_to?`

For creator outreach, callers should normally send one creator per message rather than use CC/BCC.

Returns SMTP acceptance/rejection details and the generated RFC `Message-ID`.

### `reply_email`

Write action.

Inputs:

- `message_id`: stable connector message ID for the message being replied to
- `text`
- `html?`
- `reply_all?` — default false

Behavior:

1. Fetch the target message.
2. Resolve reply recipients conservatively.
3. Preserve thread headers.
4. Prefix subject with `Re:` only when necessary.
5. Send through SMTP.
6. Return recipient list, accepted/rejected addresses, and new RFC `Message-ID`.

### `send_email_batch`

Write action for multiple creator emails from chat.

Input is an array of message objects. Each object contains its own recipients, subject, and body. The tool **does not** convert the array into one CC/BCC message.

Safety and reliability rules:

- Default maximum: 10 individual emails per MCP invocation.
- Hard maximum: 25 individual emails per invocation.
- Validate every recipient before the first send.
- Reject duplicate recipient + subject combinations inside one request unless `allow_duplicates=true` is explicitly supplied.
- Process messages individually and return an itemized result so one rejected recipient does not hide the outcome of the rest.
- No silent retries after an SMTP response that indicates permanent rejection.
- Transient failures may receive one bounded retry.
- The connector never invents or rewrites creator-specific copy; content comes from ChatGPT/tool inputs.

Larger outreach lists are sent through multiple explicit batches. This keeps each write action understandable and auditable in the chat.

## 6. Threading rules

Outgoing new messages receive a generated `Message-ID` under a configurable sender domain when the SMTP library/provider does not supply a usable one.

Replies use:

- `In-Reply-To: <parent-message-id>`
- `References: <existing references> <parent-message-id>`
- compatible `Re:` subject normalization

Sent-message lookup must not depend only on subject because creator outreach often reuses similar subjects.

## 7. Alibaba Cloud mail transport

Runtime configuration uses environment variables/secrets. No mailbox credential is stored in source files, test fixtures, Git history, logs, or MCP tool outputs.

Expected v1 variables:

```text
MAIL_USERNAME=
MAIL_APP_PASSWORD=
MAIL_IMAP_HOST=imap.qiye.aliyun.com
MAIL_IMAP_PORT=993
MAIL_SMTP_HOST=smtp.qiye.aliyun.com
MAIL_SMTP_PORT=465
MAIL_FROM_NAME=CAMPX
CONNECTOR_AUTH_TOKEN=
```

TLS certificate validation remains enabled. Plaintext IMAP/SMTP downgrade is not allowed.

The mailbox should use an Alibaba Mail third-party client/app password rather than the primary account password when that option is available.

## 8. MCP endpoint and access control

The server is remote and HTTPS-only.

For development, the server supports an authorization boundary so an unauthenticated internet client cannot read or send CAMPX mail. The concrete ChatGPT app authentication configuration will be selected to match the target workspace capabilities; the mail transport credentials remain server-side regardless.

The server never returns `MAIL_APP_PASSWORD`, connector secrets, raw environment contents, or sensitive authentication headers.

Write tools are separated from read tools so ChatGPT/workspace action controls can distinguish them.

## 9. Errors and observability

Errors are normalized into safe categories:

- `AUTH_FAILED`
- `IMAP_UNAVAILABLE`
- `SMTP_UNAVAILABLE`
- `MESSAGE_NOT_FOUND`
- `MAILBOX_NOT_FOUND`
- `INVALID_ADDRESS`
- `THREAD_NOT_FOUND`
- `RECIPIENT_REJECTED`
- `RATE_LIMITED`
- `TRANSIENT_MAIL_ERROR`
- `INTERNAL_ERROR`

Tool errors must not include passwords, SMTP auth blobs, full connection strings, or arbitrary server stack traces.

Structured logs contain operation name, duration, outcome, mailbox, non-secret message identifiers, and counts. Email body text is excluded from normal logs.

## 10. Project structure

```text
src/
  server.ts
  config.ts
  auth/
    bearer.ts
  mail/
    imap-client.ts
    smtp-client.ts
    parser.ts
    threading.ts
    addresses.ts
    types.ts
  tools/
    list-mailboxes.ts
    search-emails.ts
    get-email.ts
    get-thread.ts
    send-email.ts
    reply-email.ts
    send-email-batch.ts
  errors.ts
  logging.ts
tests/
  unit/
  integration/
.env.example
.gitignore
package.json
tsconfig.json
README.md
```

## 11. Testing strategy

### Unit tests

- MIME parsing.
- Plain-text extraction.
- Address normalization/validation.
- Subject normalization.
- Thread resolution using RFC headers.
- Heuristic thread fallback.
- Reply header construction.
- Batch duplicate detection and limits.
- Error redaction.

### Integration tests

Use a controllable IMAP/SMTP test account or local test mail server to verify:

- login over TLS
- folder listing
- search
- fetch
- new send
- reply threading
- accepted/rejected recipients
- batch partial success

Real CAMPX mailbox credentials are never used in automated CI.

### Manual end-to-end acceptance

With the CAMPX mailbox configured through deployment secrets:

1. Search a known test message from ChatGPT/MCP client.
2. Read the complete body.
3. Send a test message to an owned test inbox.
4. Reply from the owned inbox.
5. Search and read the reply through the connector.
6. Reply through `reply_email` and verify the same mail thread in both clients.
7. Send a batch to multiple owned test inboxes and verify they are separate messages, not a shared recipient list.

## 12. Deployment

The project ships as a small stateless Node.js service with a remote MCP HTTP endpoint.

Deployment requirements:

- Node.js LTS runtime.
- HTTPS endpoint.
- Environment/secret injection.
- Outbound TCP access to IMAP 993 and SMTP 465.
- Health endpoint that checks process health without exposing mailbox data.

No database is required for v1. Stable message references encode or map enough mailbox/UID information to retrieve messages without building a CRM datastore.

## 13. Future-compatible extension points

Not implemented in v1, but the interfaces should permit later additions without redesigning the connector:

- multiple CAMPX/GETEEN mailboxes
- draft creation
- attachment fetch/send
- mark read/unread
- archive/move/label-style actions
- explicit scheduled follow-up actions
- creator contact lookup from another connector
- safe large-batch job execution

These remain extensions; the initial implementation stays focused on direct mail interaction from chat.

## 14. Acceptance criteria

The implementation is complete when all of the following are true:

1. A remote MCP client can discover the seven defined tools.
2. Read tools can find and return real mailbox replies without exposing credentials.
3. `send_email` successfully sends a new CAMPX message.
4. `reply_email` produces a reply that appears in the expected conversation thread in normal mail clients.
5. `send_email_batch` sends separate creator messages and reports each result independently.
6. No secret is committed to Git or returned by a tool.
7. Unit tests cover threading, parsing, validation, redaction, and batch constraints.
8. Integration tests cover core IMAP/SMTP operations with non-production credentials.
9. README documents local setup, deployment, MCP registration, and the secret configuration process.
