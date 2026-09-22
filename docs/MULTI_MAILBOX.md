# Multi-Mailbox Migration

This document covers migration from v0.2 multi-mailbox routing to the v0.3 fail-closed model.

## Behavior change

When more than one mailbox exists, the connector no longer uses `MAIL_DEFAULT_ACCOUNT` as an implicit AI sender or read target. Ambiguous operations return `ACCOUNT_REQUIRED`.

Use an explicit `account`, or `all_accounts=true` when the intent is to search every mailbox.

`MAIL_DEFAULT_ACCOUNT` remains accepted for legacy configuration/metadata compatibility but is not an authorization to guess a sender.

## Message references

v0.3 generates HMAC-signed `message_ref` values. Set a stable `MAIL_MESSAGE_REF_SIGNING_KEY` if you plan to rotate `CONNECTOR_AUTH_TOKEN`.

Old unsigned refs remain migration-compatible only when there is one configured mailbox or when the caller explicitly supplies their account. New refs should be obtained by searching the mailbox again.

## Provider transport

Implicit TLS remains the default for Alibaba Mail/Gmail style SMTP 465. Providers using SMTP 587 can use:

```env
MAIL_SMTP_PORT=587
MAIL_SMTP_SECURITY=starttls
```

Per-account environment configuration may use `MAIL_<ACCOUNT>_SMTP_SECURITY`.

## Scale safeguards

Recommended defaults:

```env
MAIL_IMAP_ACCOUNT_CONCURRENCY=2
MAIL_ALL_ACCOUNT_READ_CONCURRENCY=4
MAIL_MULTI_ACCOUNT_SEND_CONCURRENCY=3
```

These bound connection fan-out when 10–50 mailboxes are configured. SMTP sends for one account are serialized.

## Rollout

1. Deploy v0.3 as a single replica.
2. Persist `/app/data` if using the UI store.
3. Run `npm run doctor`.
4. Check `/ready`.
5. Call `list_mailboxes` and confirm `accountSelectionRequired=true` when multiple accounts exist.
6. Search all accounts with `all_accounts=true` and verify every result has account identity.
7. Verify an ambiguous send without `account` fails with `ACCOUNT_REQUIRED`.
8. Verify an intentional cross-account reply fails with `ACCOUNT_MISMATCH`.
9. Test each provider using owned recipients before creator outreach.
