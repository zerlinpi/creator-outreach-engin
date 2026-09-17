# Limit & Capacity Testing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish deterministic, non-production operating limits for the creator outreach MCP connector before any real-mail load test, then harden any boundary that fails.

**Architecture:** Add a dedicated limit-test suite that exercises only in-memory/mock IMAP and SMTP dependencies plus the local MCP HTTP surface. The suite will verify hard ceilings and concurrency invariants rather than flaky wall-clock performance targets. Results and safe operating guidance will be documented separately from the normal functional test suite.

**Tech Stack:** Node.js 22, TypeScript 5.9, Vitest 5, Model Context Protocol SDK, Express 5.

**Spec:** `docs/STATUS.md` and the repository's existing production safeguards.

## Global Constraints

- Never send mail to a real creator or production mailbox during repository limit tests.
- Keep v1 single-replica; idempotency protection is process-local memory.
- Preserve batch hard maximum of 25 messages per tool invocation.
- Preserve maximum unique SMTP envelope recipients of 21.
- Preserve `CONNECTOR_JSON_LIMIT` range of 32 KiB through 2 MiB.
- Preserve idempotency maximum capacity of 1000 entries by default and fail closed at capacity.
- Avoid wall-clock latency assertions in CI; assert bounded counts, concurrency, response status, and resource-policy behavior instead.
- Use TDD for every production behavior change: failing regression first, then minimal implementation.

---

### Task 1: Limit-test harness and scripts

**Files:**
- Modify: `package.json`
- Create: `tests/limits/idempotency.limit.test.ts`
- Create: `tests/limits/batch.limit.test.ts`
- Create: `tests/limits/mcp-http.limit.test.ts`

**Interfaces:**
- Consumes: `IdempotencyStore.execute`, `executeBatch`, `createHttpApp`.
- Produces: `npm run test:limits`, a deterministic repository-only capacity gate.

- [ ] **Step 1: Add failing limit tests for existing hard ceilings**

Add tests that assert:
- 1000 distinct idempotency entries are accepted and the 1001st is rejected with `RATE_LIMITED` while entries are unexpired.
- 1000 concurrent replays of one idempotency key invoke the underlying operation exactly once.
- A 25-message batch with `delay_ms=0` executes sequentially with maximum observed SMTP concurrency exactly 1.
- A 25-message batch with one explicit transient retry per item performs no more than 50 send attempts.
- 26 batch messages are rejected before any send.

- [ ] **Step 2: Add `test:limits` script**

Use:

```json
"test:limits": "vitest run tests/limits"
```

- [ ] **Step 3: Run limit tests**

Run: `npm run test:limits`
Expected: existing intended ceilings pass; any discovered boundary mismatch fails with a specific assertion.

- [ ] **Step 4: Commit harness**

Commit message:

```text
test: add deterministic connector limit suite
```

---

### Task 2: MCP HTTP request-size and concurrency boundaries

**Files:**
- Modify: `tests/limits/mcp-http.limit.test.ts`
- Modify production code only if a failing test proves a boundary defect.

**Interfaces:**
- Consumes: `createHttpApp`, MCP `Client`, `StreamableHTTPClientTransport`.
- Produces: verified local HTTP/MCP behavior under bounded concurrent calls.

- [ ] **Step 1: Write the concurrent MCP test**

Start one local app with mock IMAP/SMTP adapters, connect an MCP client, and issue 100 concurrent read-only `search_emails` calls. Assert all 100 responses are valid and no write path is invoked.

- [ ] **Step 2: Write request-size boundary tests**

Start apps configured with `jsonLimit='32kb'` and `jsonLimit='2mb'`. Send an oversized JSON POST body to `/mcp` and assert the request is rejected before tool execution. Also verify a small authorized MCP request remains functional.

- [ ] **Step 3: Run RED/GREEN cycle if needed**

Run: `npm run test:limits`
Expected: PASS. If a boundary fails, add the smallest production fix after confirming the test fails for the intended reason.

- [ ] **Step 4: Commit HTTP boundary coverage**

Commit message:

```text
test: verify MCP concurrency and request ceilings
```

---

### Task 3: Idempotency failure and recovery pressure

**Files:**
- Modify: `tests/limits/idempotency.limit.test.ts`
- Modify: `src/mail/idempotency.ts` only if a failing test exposes incorrect recovery semantics.

**Interfaces:**
- Consumes: `IdempotencyStore` constructor options (`ttlMs`, `maxEntries`, `now`).
- Produces: verified capacity recovery after expiry and safe replay of settled failures.

- [ ] **Step 1: Add capacity-recovery test**

Use a fake clock. Fill the configured store capacity, settle all operations, advance past TTL, then verify new keys are admitted and old entries are pruned.

- [ ] **Step 2: Add failure replay pressure test**

Execute one failing operation and replay the same key 100 times inside TTL. Assert the original operation runs once and all replays receive the same failure semantics.

- [ ] **Step 3: Add conflict pressure test**

Reuse one key with a different payload 100 times and assert all conflicts return `IDEMPOTENCY_CONFLICT` without invoking the operation.

- [ ] **Step 4: Run suite and fix only proven defects**

Run: `npm run test:limits && npm test && npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

Commit message:

```text
test: pressure idempotency recovery semantics
```

---

### Task 4: Batch fault-pressure boundaries

**Files:**
- Modify: `tests/limits/batch.limit.test.ts`
- Modify: `src/mail/batch.ts` only if failing tests expose an invariant violation.

**Interfaces:**
- Consumes: `executeBatch`, `preflightBatch`, `ConnectorError`.
- Produces: verified bounded attempts and independent per-recipient failure isolation.

- [ ] **Step 1: Add mixed-outcome 25-item test**

Use a deterministic fake sender that succeeds, permanently rejects, and transiently fails by index. Assert one result per input, stable input order, and no failure aborts later recipients.

- [ ] **Step 2: Add retry bound test**

With `retryTransient=true`, force all 25 items to transiently fail twice. Assert exactly 50 attempts, 25 failed results, and no third attempt.

- [ ] **Step 3: Add worst-case timing rejection test**

Verify a configuration whose explicit inter-message/retry waits exceed 60 seconds is rejected before any send.

- [ ] **Step 4: Run complete local gates**

Run: `npm run test:limits && npm test && npm run typecheck && npm run build`
Expected: all PASS.

- [ ] **Step 5: Commit**

Commit message:

```text
test: verify maximum batch fault isolation
```

---

### Task 5: Operating envelope documentation and CI gate

**Files:**
- Create: `docs/LIMITS.md`
- Modify: `.github/workflows/ci.yml`
- Modify: `docs/STATUS.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: measured deterministic test outcomes from Tasks 1-4.
- Produces: a documented, continuously enforced v1 operating envelope.

- [ ] **Step 1: Document verified repository-only limits**

Record:
- MCP request body: configurable 32 KiB–2 MiB, default 1 MiB.
- Search result maximum: 100 messages per search tool call.
- Batch: maximum 25 messages, sequential SMTP execution.
- SMTP envelope: maximum 21 unique recipients per message.
- Idempotency: default 1000 protected keys, 15-minute post-settlement TTL, single-process scope.
- Safe test concurrency: 100 simultaneous read-only MCP calls against mocked dependencies.
- Explicitly state that these are connector/code limits, not Alibaba Mail provider quotas.

- [ ] **Step 2: Add limit suite to CI**

Add `npm run test:limits` after normal tests and before typecheck.

- [ ] **Step 3: Update status**

Move repository-only limit testing to complete. Keep provider/live load verification listed as external and not yet complete.

- [ ] **Step 4: Run final verification**

Run through GitHub Actions on the exact PR head:
- `npm ci`
- `npm test`
- `npm run test:limits`
- `npm run typecheck`
- `npm run build`
- production dependency audit
- full dependency audit
- Docker build

Expected: all green.

- [ ] **Step 5: Merge only after exact-head CI success**

Use squash merge into `main`, then verify the push-triggered `main` CI is green before declaring the repository limit phase complete.
