# Limit and Capacity Verification

Last updated: 2026-09-18

## Purpose

This document separates connector-internal capacity from external mail-provider limits.

The repository limit suite uses in-process mock IMAP/SMTP adapters. It never contacts creators and never sends real email. These tests verify that the single-replica MCP service preserves correctness while requests are concurrent and while configured limits are reached.

They do **not** establish Alibaba Mail account quotas, provider rate limits, network latency, or production throughput SLAs.

## Verified connector-internal limits

Capacity-bound high-water verification passed on GitHub Actions run 133 for commit `26449c2f85cb377e8810cdc2db3b9b5882843fcb`:

- 500 concurrent MCP read-tool calls complete successfully through one session.
- 1000 concurrent replays of the same `send_email` request coalesce into exactly one SMTP adapter call.
- 1000 concurrent distinct idempotent writes fill the default idempotency capacity without dropped mock sends; the next unique key fails closed with `RATE_LIMITED`.
- The default idempotency store safely protects 1000 entries and fails closed on entry 1001.
- A 25-message batch is accepted when configured with `max=25`.
- A 26-message batch is rejected before SMTP is invoked.
- A request body larger than a configured 32 KiB JSON cap is rejected with HTTP 413 before MCP handling.
- The complete repository suite passes with 87 tests, with three credential-gated live tests skipped by design (IMAP, single SMTP send, and provider pacing).
- At the capacity-bound high-water mark, the six limit tests completed in about 10.0 seconds and the full repository suite completed in about 10.6 seconds on that specific GitHub-hosted runner. This timing is evidence only, not a guaranteed performance target.

## Current operational ceiling

For v1, use one connector replica.

The product-level sending ceiling remains intentionally lower than the internal concurrency checks:

- one primary creator recipient per `send_email`;
- maximum 25 messages per `send_email_batch`;
- sequential batch delivery;
- configured worst-case batch wait no greater than 60 seconds;
- automatic transient retry disabled unless explicitly requested;
- 1000 protected idempotency entries per running process by default.

Do not increase batch size or horizontally scale the service merely because mock concurrency tests pass. The current idempotency store is process-local and Alibaba Mail has independent provider-side limits.

## Reproduce repository-safe limit tests

```bash
npm ci
npm run test:limit
```

The normal `npm test` command also includes this suite.

## Next stage: external controlled verification

External verification must use an owned, non-production mailbox and owned recipient addresses.

Run in this order:

1. `npm run doctor` with deployment secrets.
2. Opt-in live IMAP integration test.
3. One live SMTP message to an owned recipient.
4. Verify that the message appears in the provider Sent folder and can be found by `search_emails`.
5. Reply from the owned inbox and verify `get_thread`.
6. Test idempotency replay against the deployed single replica.
7. Test provider pacing with small, controlled sequences of 1, 5, 10, then 25 owned-recipient messages.
8. Stop increasing load on the first provider deferral, rate-limit response, timeout increase, duplicate-delivery ambiguity, or Sent-folder inconsistency.

Do not use creator addresses for limit testing.

## Pass criteria for the external stage

The external stage is considered safe for creator outreach only when:

- doctor checks pass;
- IMAP and SMTP live tests pass with owned addresses;
- no duplicate delivery occurs on same-key replay;
- provider rate-limit and transient failures are surfaced without unsafe automatic resend;
- Inbox/Sent thread reconstruction remains correct;
- the deployed service remains single-replica;
- HTTPS MCP registration in ChatGPT exposes exactly the intended seven tools.

## Opt-in provider pacing harness

The repository includes a live SMTP pacing harness that is disabled unless all required variables are explicitly supplied. It is intended only for an owned non-production mailbox and an owned recipient.

Start at one message:

```bash
TEST_MAIL_USERNAME=test-mailbox@example.com \\
TEST_MAIL_APP_PASSWORD=... \\
TEST_MAIL_RECIPIENT=owned-test-inbox@example.com \\
TEST_MAIL_LIVE_PACING=true \\
TEST_MAIL_PACING_COUNT=1 \\
TEST_MAIL_PACING_DELAY_MS=500 \\
npm run test:provider-pacing
```

Then repeat with counts 5, 10, and at most 25 only if the previous stage is clean. The harness is sequential, enforces a 1–25 message count and a 250–5000 ms delay, and stops on the first thrown provider failure. CI never enables this test.
