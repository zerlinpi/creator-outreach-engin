# Creator Outreach Mail Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deployable remote MCP connector that lets ChatGPT search/read CAMPX Alibaba Mail, inspect threads, send/reply to individual creator emails, and send small batches of separate personalized outreach messages.

**Architecture:** A stateless Node.js/TypeScript MCP HTTP service exposes seven mail tools. IMAP access is isolated behind a read adapter; SMTP sending is isolated behind a write adapter; MIME parsing/thread reconstruction and reply-header construction are pure/testable modules. Secrets stay in environment variables and the service uses bearer authentication at the HTTP boundary.

**Tech Stack:** Node.js 22+, TypeScript 5+, MCP TypeScript SDK for the 2026-07-28 protocol, Zod 4, ImapFlow, Nodemailer, MailParser, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-17-creator-outreach-mail-connector-design.md`

## Global Constraints

- One CAMPX Alibaba Cloud enterprise mailbox for v1.
- IMAP over TLS only; default `imap.qiye.aliyun.com:993`.
- SMTP over TLS only; default `smtp.qiye.aliyun.com:465`.
- No CRM UI, contact database, autonomous negotiation, or campaign scheduler.
- No production mailbox credentials in source, tests, Git history, logs, or MCP outputs.
- `send_email_batch` sends separate messages, default max 10 and hard max 25 per call.
- Remote MCP endpoint must distinguish read tools from write tools and require bearer authentication.
- Unit/integration tests must not use CAMPX production credentials.

---

### Task 1: Project scaffold, configuration, and safe error model

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `src/config.ts`
- Create: `src/errors.ts`
- Test: `tests/unit/config.test.ts`
- Test: `tests/unit/errors.test.ts`

**Interfaces:**
- Produces: `loadConfig(env?: NodeJS.ProcessEnv): AppConfig`
- Produces: `ConnectorError`, `toSafeError(error: unknown): SafeToolError`

- [ ] **Step 1: Write failing configuration tests** verifying required `MAIL_USERNAME`, `MAIL_APP_PASSWORD`, and `CONNECTOR_AUTH_TOKEN`; default Alibaba IMAP/SMTP hosts/ports; invalid numeric ports fail.
- [ ] **Step 2: Run `npm test -- tests/unit/config.test.ts`** and confirm failure because `src/config.ts` does not exist.
- [ ] **Step 3: Implement minimal `loadConfig`** using Zod with TLS defaults and no secret logging helpers.
- [ ] **Step 4: Run config tests** and confirm pass.
- [ ] **Step 5: Write failing error-redaction tests** verifying secrets and stack traces never appear in returned errors.
- [ ] **Step 6: Implement `ConnectorError` and `toSafeError`** with the spec error codes.
- [ ] **Step 7: Run all Task 1 tests** and confirm pass.
- [ ] **Step 8: Commit** `chore: scaffold connector configuration`.

### Task 2: Pure mail utilities — addresses, parsing, threading, reply headers

**Files:**
- Create: `src/mail/types.ts`
- Create: `src/mail/addresses.ts`
- Create: `src/mail/parser.ts`
- Create: `src/mail/threading.ts`
- Test: `tests/unit/addresses.test.ts`
- Test: `tests/unit/parser.test.ts`
- Test: `tests/unit/threading.test.ts`

**Interfaces:**
- Produces: `normalizeAddress`, `validateAddressList`
- Produces: `parseMessage(source): Promise<NormalizedMessage>`
- Produces: `normalizeSubject`, `buildReplyHeaders`, `resolveThread`

- [ ] **Step 1: Write failing address tests** for whitespace/case normalization, invalid mailboxes, and duplicate removal.
- [ ] **Step 2: Run address tests** and confirm RED.
- [ ] **Step 3: Implement minimal address utilities** and confirm GREEN.
- [ ] **Step 4: Write failing MIME parser tests** using raw RFC 5322 fixtures for text/plain, multipart HTML+text, encoded subject, `Message-ID`, `References`, and attachment metadata.
- [ ] **Step 5: Implement minimal parser using `mailparser`** and confirm parser tests pass.
- [ ] **Step 6: Write failing threading tests** for exact RFC header chains, `Re:` normalization, references de-duplication, and heuristic subject+participant fallback marking.
- [ ] **Step 7: Implement threading helpers** and confirm all utility tests pass.
- [ ] **Step 8: Commit** `feat: add mail parsing and threading primitives`.

### Task 3: IMAP read adapter

**Files:**
- Create: `src/mail/imap-client.ts`
- Test: `tests/unit/imap-client.test.ts`
- Test: `tests/integration/imap.integration.test.ts`

**Interfaces:**
- Produces: `ImapMailClient` with `listMailboxes()`, `searchEmails(criteria)`, `getEmail(ref)`, `getThread(input)`.
- Consumes: `AppConfig`, parser/threading utilities.

- [ ] **Step 1: Write failing unit tests around query construction and stable message references** without opening a network connection.
- [ ] **Step 2: Implement the smallest query/reference helpers** needed for GREEN.
- [ ] **Step 3: Write opt-in integration tests** guarded by `TEST_IMAP_*` variables for TLS login, folder listing, search, and fetch against a non-production mailbox.
- [ ] **Step 4: Implement `ImapMailClient` with ImapFlow**, short-lived connections per tool call, lock/release discipline, and normalized safe errors.
- [ ] **Step 5: Run unit tests; run integration tests only when test credentials exist.**
- [ ] **Step 6: Commit** `feat: add imap read adapter`.

### Task 4: SMTP send adapter and reply construction

**Files:**
- Create: `src/mail/smtp-client.ts`
- Create: `src/mail/reply.ts`
- Test: `tests/unit/reply.test.ts`
- Test: `tests/unit/smtp-client.test.ts`
- Test: `tests/integration/smtp.integration.test.ts`

**Interfaces:**
- Produces: `SmtpMailClient.send(message): Promise<SendResult>`
- Produces: `buildReplyMessage(parent, input, mailboxAddress): OutgoingMessage`
- Consumes: `AppConfig`, address/threading utilities.

- [ ] **Step 1: Write failing reply-builder tests** for recipient resolution, reply-all behavior, `In-Reply-To`, `References`, and `Re:` subject handling.
- [ ] **Step 2: Implement minimal reply builder** and confirm GREEN.
- [ ] **Step 3: Write failing SMTP adapter tests** around validated Nodemailer options and normalized accepted/rejected results.
- [ ] **Step 4: Implement SMTP client using Nodemailer** with implicit TLS on 465 and generated `Message-ID` support.
- [ ] **Step 5: Add opt-in integration test** using `TEST_SMTP_*` and an owned recipient; never production CAMPX credentials in CI.
- [ ] **Step 6: Run Task 4 unit tests and available integration tests.**
- [ ] **Step 7: Commit** `feat: add smtp sending and reply construction`.

### Task 5: MCP read tools and authenticated HTTP server

**Files:**
- Create: `src/auth/bearer.ts`
- Create: `src/tools/list-mailboxes.ts`
- Create: `src/tools/search-emails.ts`
- Create: `src/tools/get-email.ts`
- Create: `src/tools/get-thread.ts`
- Create: `src/server.ts`
- Test: `tests/unit/auth.test.ts`
- Test: `tests/unit/read-tools.test.ts`
- Test: `tests/integration/mcp-read.integration.test.ts`

**Interfaces:**
- Produces: authenticated `/mcp` endpoint.
- Produces MCP tools: `list_mailboxes`, `search_emails`, `get_email`, `get_thread`.
- Consumes: `ImapMailClient`.

- [ ] **Step 1: Write failing bearer-auth tests** for missing, malformed, and constant-time-matched tokens.
- [ ] **Step 2: Implement auth middleware/helper** and confirm GREEN.
- [ ] **Step 3: Write failing read-tool tests** using a fake `ImapMailClient` to assert Zod input validation and output shape.
- [ ] **Step 4: Implement read tool registrations** with concise descriptions suitable for ChatGPT tool selection.
- [ ] **Step 5: Write failing MCP HTTP integration test** that discovers tools through the SDK client and verifies unauthenticated requests are rejected.
- [ ] **Step 6: Implement the MCP HTTP server** using the current MCP TypeScript SDK for the 2026-07-28 protocol with compatibility for current ChatGPT client expectations.
- [ ] **Step 7: Run all Task 5 tests.**
- [ ] **Step 8: Commit** `feat: expose authenticated mcp read tools`.

### Task 6: MCP write tools and batch safety

**Files:**
- Create: `src/tools/send-email.ts`
- Create: `src/tools/reply-email.ts`
- Create: `src/tools/send-email-batch.ts`
- Create: `src/mail/batch.ts`
- Test: `tests/unit/batch.test.ts`
- Test: `tests/unit/write-tools.test.ts`
- Test: `tests/integration/mcp-write.integration.test.ts`

**Interfaces:**
- Produces MCP tools: `send_email`, `reply_email`, `send_email_batch`.
- Produces: `validateBatch(messages, options)` and bounded transient retry behavior.
- Consumes: `ImapMailClient`, `SmtpMailClient`, `buildReplyMessage`.

- [ ] **Step 1: Write failing batch tests** for default max 10, hard max 25, duplicate recipient+subject rejection, invalid-recipient preflight, and independent per-item result reporting.
- [ ] **Step 2: Implement minimal batch validator/executor** and confirm GREEN.
- [ ] **Step 3: Write failing write-tool tests** confirming `reply_email` fetches the parent before sending and batch sends separate SMTP messages.
- [ ] **Step 4: Implement the three write tool registrations.**
- [ ] **Step 5: Add MCP integration tests** with fake adapters to verify tool discovery, input validation, and exact result payloads without sending real mail.
- [ ] **Step 6: Run all Task 6 tests.**
- [ ] **Step 7: Commit** `feat: expose mcp send reply and batch tools`.

### Task 7: Deployment readiness, documentation, and end-to-end verification harness

**Files:**
- Create: `README.md`
- Create: `Dockerfile`
- Create: `.dockerignore`
- Create: `src/health.ts`
- Create: `tests/integration/health.integration.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `GET /health` with no mailbox data.
- Documents local run, deployment, secrets, ChatGPT MCP registration, and safe test procedure.

- [ ] **Step 1: Write failing health test** asserting `200` with only non-sensitive process status.
- [ ] **Step 2: Implement health endpoint** and confirm GREEN.
- [ ] **Step 3: Add production scripts** for `build`, `start`, `test`, `test:integration`, and `typecheck`.
- [ ] **Step 4: Add Dockerfile** targeting Node 22, non-root runtime, and no `.env` copy.
- [ ] **Step 5: Write README** with Alibaba IMAP/SMTP environment setup, app-password guidance, MCP URL, bearer-token configuration, and examples of chat requests for single and multi-creator mail.
- [ ] **Step 6: Run `npm test`, `npm run typecheck`, and `npm run build`.**
- [ ] **Step 7: If test mailbox credentials are present, run opt-in IMAP/SMTP integration tests; otherwise explicitly record that production-network verification is pending credentials.**
- [ ] **Step 8: Commit** `docs: add deployment and connector setup`.

## Final verification

- [ ] Run complete unit suite with no network credentials.
- [ ] Run typecheck and production build.
- [ ] Inspect Git diff for accidental credentials or `.env` files.
- [ ] Confirm MCP tool list contains exactly the seven designed mail tools.
- [ ] Confirm write tool schemas expose individual recipients rather than implicit CC/BCC batching.
- [ ] Confirm normal logs do not contain message bodies or credentials.
- [ ] Confirm README clearly separates connector implementation from ChatGPT workspace capability/registration requirements.
