# Mailbox Manager v0.2.0

The Mailbox Manager is the recommended way to operate many creator-outreach inboxes from one MCP deployment.

## Goal

A deployment can have 0, 1, 10, or more mailboxes without adding new MCP tools or copying environment-variable blocks. The browser UI owns mailbox setup, while AI sees only safe mailbox identity and message content.

## Initial server setup

Set these once:

```env
MAIL_ADMIN_PASSWORD=<16+ characters>
MAIL_ACCOUNT_STORE_KEY=<32+ random characters>
MAIL_ACCOUNT_STORE_PATH=./data/mail-accounts.enc.json
MAIL_MAX_ACCOUNTS=50
CONNECTOR_AUTH_TOKEN=<32+ characters>
```

Open `/admin`. Browser Basic Auth uses username `admin`.

Each mailbox form contains:

- stable account id, for example `campx`, `geteen_us`, or `hassky_support`;
- email address;
- app/mailbox password;
- From name;
- IMAP host/port;
- SMTP host/port.

Alibaba Mail and Gmail presets are included. Custom endpoints can be entered manually.

## Credential security

Only mailbox metadata is readable from the UI API. Passwords are encrypted with AES-256-GCM before being written to `MAIL_ACCOUNT_STORE_PATH`.

The encryption key is not stored in that file. Losing or changing `MAIL_ACCOUNT_STORE_KEY` makes the stored passwords undecryptable.

The MCP surface never returns mailbox passwords.

## AI read isolation

Every new IMAP message reference embeds the owning account id in addition to mailbox, UID, and UIDVALIDITY.

For one mailbox:

```json
{"account":"campx","from":"creator@example.com"}
```

For all mailboxes:

```json
{"all_accounts":true,"from":"creator@example.com","limit":50}
```

All-account output contains:

- `searchedAccounts`;
- globally date-sorted `results`;
- an explicit `account` and `accountAddress` on every result;
- a separate `failures` array for mailboxes that could not be searched.

A failure in one mailbox never causes successful results from other mailboxes to be discarded.

`get_email`, `get_thread`, and `reply_email` infer the owning account from `message_ref`. Supplying a different account produces `ACCOUNT_MISMATCH` before any send occurs.

## Multi-account sending

Single-account batch mode remains compatible:

```json
{
  "account":"campx",
  "messages":[
    {"to":["a@example.com"],"subject":"A","text":"..."},
    {"to":["b@example.com"],"subject":"B","text":"..."}
  ],
  "idempotency_key":"campx-run-001"
}
```

Multi-account mode omits the top-level account and puts an account on every message:

```json
{
  "messages":[
    {"account":"campx","to":["a@example.com"],"subject":"A","text":"..."},
    {"account":"hassky","to":["b@example.com"],"subject":"B","text":"..."},
    {"account":"geteen_us","to":["c@example.com"],"subject":"C","text":"..."}
  ],
  "idempotency_key":"multi-brand-run-001"
}
```

Rules:

1. Every message must name its sender account.
2. Top-level `account` is forbidden in multi-account mode.
3. Unknown accounts fail before sending.
4. Different account groups execute concurrently.
5. Messages inside one account remain sequential and keep provider pacing.
6. Every multi-account result contains `account` and `accountAddress`.
7. Idempotency protects the full multi-account request from duplicate retries.

This makes sender identity visible to both the AI and the operator instead of relying on message order or mailbox guessing.

## Docker persistence

The image creates writable `/app/data`. Mount it persistently:

```yaml
volumes:
  - ./creator-mail-data:/app/data
```

Without persistent storage, UI-managed mailbox configuration is lost when the container filesystem is replaced.

## Legacy environment accounts

Environment-managed accounts still work. They appear in the UI as `environment` source and are intentionally read-only.

Account ids must be globally unique. If the same id exists in environment configuration and the encrypted UI store, startup fails instead of silently choosing one.

## Verification

After adding mailboxes:

1. click **Test** for each mailbox in `/admin`;
2. run `npm run doctor`;
3. call `list_mailboxes` and verify account ids/addresses;
4. run `search_emails(all_accounts=true)`;
5. verify every returned result has the expected account;
6. dry-run a multi-account batch;
7. send only to owned test recipients;
8. verify each message appears in the correct provider Sent folder.
