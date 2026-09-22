# Mailbox Manager v0.3.4

The Mailbox Manager is the recommended way to operate many creator-outreach inboxes from one MCP deployment.

## Setup

Configure the server once:

```env
MAIL_ADMIN_PASSWORD=<16+ characters>
MAIL_ACCOUNT_STORE_KEY=<32+ random characters>
MAIL_ACCOUNT_STORE_PATH=./data/mail-accounts.enc.json
MAIL_MAX_ACCOUNTS=50
CONNECTOR_AUTH_TOKEN=<32+ characters>
MAIL_MESSAGE_REF_SIGNING_KEY=<optional independent 32+ character secret>
```

Open `/admin` over HTTPS and authenticate with username `admin`. The UI can add, edit, test, and delete mailboxes without restarting the service.

The form supports Alibaba Mail, Gmail, Microsoft 365 / Outlook, and custom endpoints. SMTP security can be implicit TLS or STARTTLS.

## Credential and admin safety

Mailbox passwords are encrypted at rest with AES-256-GCM and are never returned by the admin API or MCP. The encrypted store and `data/` directory are ignored by Git and Docker build context.

Admin pages are no-store, deny framing, reject cross-origin browser mutations, and rate-limit failed Basic-auth attempts. Store and runtime-registry mutations are serialized so concurrent edits cannot silently overwrite each other.

Persist `/app/data` when using Docker.

## AI mailbox isolation

With exactly one mailbox, account selection may be omitted.

With two or more mailboxes, ambiguous operations fail closed with `ACCOUNT_REQUIRED`. AI must either:

- specify `account` for one-mailbox search/send/thread-by-participant; or
- use `all_accounts=true` for a cross-mailbox search.

There is no implicit “default sender” in multi-mailbox mode.

New message references are HMAC-signed and bind account + mailbox + UIDVALIDITY + UID. `get_email`, `get_thread`, and `reply_email` use that signed ref to retain the owning account. A mismatched explicit account fails with `ACCOUNT_MISMATCH`.

Unsigned v0.2 message refs are migration-only: they may be used automatically with one mailbox, or with multiple mailboxes only when the caller explicitly supplies the account.

## All-mailbox search

Example:

```json
{
  "all_accounts": true,
  "from": "creator@example.com",
  "limit": 50,
  "per_account_limit": 20
}
```

Results are globally sorted and every item carries `account` and `accountAddress`. Per-mailbox failures are reported separately. Search fan-out is bounded by `MAIL_ALL_ACCOUNT_READ_CONCURRENCY`; each account also has `MAIL_IMAP_ACCOUNT_CONCURRENCY`.

## Sending

Single sender:

```json
{
  "account": "campx",
  "to": ["creator@example.com"],
  "subject": "Hello",
  "text": "...",
  "idempotency_key": "campx-001"
}
```

Multi-account batch:

```json
{
  "messages": [
    {"account":"campx","to":["a@example.com"],"subject":"A","text":"..."},
    {"account":"hassky","to":["b@example.com"],"subject":"B","text":"..."},
    {"account":"geteen_us","to":["c@example.com"],"subject":"C","text":"..."}
  ],
  "idempotency_key": "multi-brand-001"
}
```

Every message must name its sender in multi-account batch mode. Different account groups run with bounded concurrency; sends within the same account are serialized and keep batch pacing.

## Deployment checks

Use `GET /health` for process liveness and `GET /ready` for mailbox readiness. After building, run `npm run doctor` to test each configured IMAP/SMTP account without sending mail; it no longer rebuilds or deletes production `dist/`. Run `npm run probe` after deployment to verify the public HTTP/OAuth/MCP surface.

Production guidance remains single replica because idempotency state is process-local.
