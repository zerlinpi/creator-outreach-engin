# Mailbox Manager v0.3.6

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

Admin pages are no-store, deny framing, reject cross-origin browser mutations, and rate-limit failed Basic-auth attempts. The browser script is served as a separate authenticated asset, inline event handlers are not used, and mailbox metadata is rendered with DOM text nodes rather than `innerHTML`. Store and runtime-registry mutations are serialized so concurrent edits cannot silently overwrite each other.

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


## Unified inbox and outreach status (read-only)

Open `/admin` and choose **Inbox & Follow-ups**. The dashboard now reads the most recent **25 messages per account from each INBOX and Sent folder** (bounded at 40 per folder through `GET /admin/api/outreach?account=all&limit=25`). It combines accounts only in the display; it never combines two different accounts into one conversation. Select a contact to read the latest message via `GET /admin/api/messages?account=<id>&ref=<message-ref>`. Message text is rendered as inert plain text, not sender-provided HTML. Existing mailbox configuration, diagnostics and MCP tools remain unchanged.

The interface adapts the mobile-friendly navigation, cards and information hierarchy of [fantastic-mobile/basic](https://github.com/fantastic-mobile/basic), **without installing Vue or copying its runtime**. The existing CSP, Basic authentication, and same-origin write restrictions still apply.

Stages are computed from the sampled IMAP messages and are **not editable CRM notes**:

| Stage | Observation in the sampled folders |
| --- | --- |
| Just contacted | One outbound message, fewer than 48 hours ago; no inbound counterpart in the sample |
| Awaiting reply | One outbound message at least 48 hours ago; no inbound counterpart in the sample |
| Followed up | Multiple outbound messages for the same recipient/normalized subject, no later reply observed |
| Just replied | Latest inbound message explicitly links to an outbound Message-ID and is within 48 hours |
| Replied | Latest inbound message explicitly links to an outbound Message-ID and is older than 48 hours |
| We replied | The latest message is outbound and the scan includes earlier inbound mail |
| Possible reply | Inbound and outbound share a participant and normalized subject, but the inbound has no matching In-Reply-To/References |
| Incoming | No matching outbound message was seen in the sample |

**Follow-up due** flags a conversation when an outbound message is at least 72 hours old and no newer inbound message was observed. It is a **review prompt**, not proof the person did not reply. The grouping key is sender account + external participant + normalized subject, so separate conversations with identical subjects may be grouped. Automatic classification cannot establish the full lifetime history when older messages fall outside the scan, emails were archived/moved, or message headers are unavailable. Do not use the counter as an exact outreach CRM conversion metric.

The response includes `limitedHistory: true` and per-folder errors. A failing INBOX or Sent scan causes that account to be excluded from the inferred-stage view, rather than incorrectly marked as unanswered. Refresh is manual to avoid continuous IMAP load. The API is intended for a single-operator read-only overview, not a persistent CRM or an IMAP-wide full-text index. It will not send messages or automatically schedule follow-ups.

**Next iteration only if needed:** implement a durable sync/index with IMAP incremental UID tracking, reliable thread IDs, explicit per-thread notes/assignment, pagination, and a persisted follow-up workflow after real-mail provider acceptance tests. These are intentionally excluded here to avoid introducing unverified database complexity.
