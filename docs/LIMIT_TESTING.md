# Limit and Capacity Verification

Last updated: 2026-09-22

## Purpose

The repository limit suite verifies connector-internal safety boundaries with local/mock IMAP and SMTP adapters. It does not establish provider quotas, real-network throughput, or a production SLA.

## v0.3 verified boundaries

The normal `npm test` gate includes the high-water limit suite. The CI budget for the 500/1000-request stress cases is 30 seconds so GitHub runner variability does not turn a correctness test into a latency benchmark.

Repository assertions include:

- 500 concurrent MCP read-tool calls through one session.
- 1000 concurrent replays of one idempotent `send_email` request coalesce into one underlying send.
- 1000 distinct protected idempotency entries are admitted; entry 1001 fails closed with `RATE_LIMITED`.
- Batch hard maximum is 25 messages; 26 is rejected before SMTP.
- One transient retry is bounded; there is no unbounded retry loop.
- JSON request limit is configurable from 32 KiB through 2 MiB.
- Search-result MIME source fetch is capped at 512 KiB per message; default is 128 KiB.
- Full-message reads have a separate configurable cap, default 10 MiB.
- All-account read fan-out is bounded by `MAIL_ALL_ACCOUNT_READ_CONCURRENCY` (default 4).
- Each account bounds IMAP connection work by `MAIL_IMAP_ACCOUNT_CONCURRENCY` (default 2).
- Multi-account send fan-out is bounded by `MAIL_MULTI_ACCOUNT_SEND_CONCURRENCY` (default 3).
- SMTP sends inside one account are serialized.
- One message can contain at most 21 unique SMTP envelope recipients.
- Batch configured worst-case delay/retry wait is capped at 60 seconds.

These limits are deliberately independent of Alibaba Mail, Gmail, or Microsoft 365 provider-side quotas.

## Operational ceiling

Production remains single replica because the idempotency store and OAuth refresh-token replay state are process-local. Do not horizontally scale merely because mock concurrency tests pass.

The Mailbox Manager encrypted file store is also a single-process writable store. Persist `/app/data`, but do not mount one writable store file into multiple connector replicas.

## Reproduce repository-safe verification

```bash
npm ci
npm test
npm run typecheck
npm run build
npm audit --omit=dev --audit-level=moderate
npm audit --audit-level=moderate
docker build -t creator-outreach-engine:verify .
```

To run only the capacity suite:

```bash
npm run test:limit
```

## External controlled verification

External verification must use owned/non-production mailboxes and owned recipients.

1. Run `npm run doctor`.
2. Confirm `GET /ready` returns 200.
3. Run opt-in live IMAP verification.
4. Send one live SMTP message to an owned recipient from each provider type.
5. Confirm each sent message appears in the correct account's Sent folder.
6. Verify all-account search preserves `account` and `accountAddress`.
7. Verify an ambiguous multi-mailbox send fails with `ACCOUNT_REQUIRED`.
8. Verify a deliberate cross-account reply fails with `ACCOUNT_MISMATCH`.
9. Replay the same idempotency key against the deployed single replica and confirm one delivery.
10. Run provider pacing at 1, 5, 10, then at most 25 owned-recipient messages, stopping on the first deferral/rate-limit/timeout anomaly.

Never use creator addresses for load/capacity testing.
