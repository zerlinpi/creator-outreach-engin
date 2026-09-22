# Multi-Mailbox Migration

This release adds multiple isolated sender mailboxes behind one MCP endpoint while preserving legacy single-mailbox environment variables.

## Recommended configuration

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

Each account can override `IMAP_HOST`, `IMAP_PORT`, `SMTP_HOST`, and `SMTP_PORT` using the same prefix.

## Compatibility

If `MAIL_ACCOUNTS` is absent, `MAIL_USERNAME`, `MAIL_APP_PASSWORD`, and `MAIL_FROM_NAME` continue to work.

Old message references without an embedded account remain usable through the requested/default account. Newly generated message references are account-scoped and should be preferred.

## Safety behavior

- Message refs bind account + mailbox + UIDVALIDITY + UID.
- Explicit account/ref mismatches fail with `ACCOUNT_MISMATCH`.
- Unknown accounts fail with `ACCOUNT_NOT_FOUND`.
- Reply sender identity is derived from the owning account.
- Idempotency keys are scoped per account.
- One batch cannot mix sender accounts.
- No automatic brand failover or sender rotation occurs.

## Rollout

1. Deploy with the existing single mailbox and confirm compatibility.
2. Add `MAIL_ACCOUNTS` plus the current mailbox as the first named account.
3. Run `npm run doctor`.
4. Add the second mailbox and rerun doctor.
5. Use owned addresses to test search/read/send/reply for both accounts.
6. Verify cross-account reply mismatch protection.
7. Only then enable creator outreach from the second mailbox.
