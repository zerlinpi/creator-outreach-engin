import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';
import type { MailAccountRegistry } from '../mail/accounts.js';
import type { IdempotencyStore } from '../mail/idempotency.js';
import { buildReplyMessage } from '../mail/reply.js';
import { executeBatch, preflightBatch } from '../mail/batch.js';
import { toEmailView, toSearchSummary } from '../mail/presenters.js';
import { toSafeError } from '../errors.js';

const email = z.string().email();
const accountId = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/).optional();
const primaryRecipient = z.array(email).length(1);
const subject = z.string().min(1).max(200).refine((value) => !/[\r\n]/.test(value), 'Subject must not contain CR or LF characters.');
const idempotencyKey = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
const failure = (error: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ error: toSafeError(error) }) }], isError: true });

function scopedKey(account: string, operation: string, key: string): string {
  return 'account:' + account + ':' + operation + ':' + key;
}

export function registerMailTools(
  server: McpServer,
  accounts: MailAccountRegistry,
  idempotency: IdempotencyStore
) {
  server.registerTool(
    'list_mailboxes',
    {
      description: 'List configured mail accounts and their folders. Pass account to inspect one account; omit it to inspect all configured accounts.',
      inputSchema: z.object({ account: accountId }),
      annotations: { readOnlyHint: true }
    },
    async ({ account }) => {
      try {
        const selected = account ? [accounts.resolve(account)] : accounts.list();
        const rows = await Promise.all(selected.map(async (runtime) => {
          try {
            return {
              account: runtime.id,
              address: runtime.address,
              fromName: runtime.fromName,
              ok: true as const,
              mailboxes: await runtime.imap.listMailboxes()
            };
          } catch (error) {
            return {
              account: runtime.id,
              address: runtime.address,
              fromName: runtime.fromName,
              ok: false as const,
              error: toSafeError(error)
            };
          }
        }));
        return result({ defaultAccount: accounts.defaultAccountId, accounts: rows });
      } catch (e) { return failure(e); }
    }
  );

  server.registerTool(
    'search_emails',
    {
      description: 'Search one mail account by sender, recipient, subject, date, unread state, or text. account is optional and defaults to the configured default account.',
      inputSchema: z.object({
        account: accountId,
        query: z.string().optional(),
        from: email.optional(),
        to: email.optional(),
        subject: z.string().optional(),
        mailbox: z.string().optional(),
        unread: z.boolean().optional(),
        since: z.string().datetime().optional(),
        before: z.string().datetime().optional(),
        limit: z.number().int().min(1).max(100).optional()
      }),
      annotations: { readOnlyHint: true }
    },
    async (a) => {
      try {
        const runtime = accounts.resolve(a.account);
        const messages = await runtime.imap.searchEmails({
          query: a.query,
          from: a.from,
          to: a.to,
          subject: a.subject,
          mailbox: a.mailbox,
          unread: a.unread,
          since: a.since ? new Date(a.since) : undefined,
          before: a.before ? new Date(a.before) : undefined,
          limit: a.limit
        });
        return result(messages.map((message) => ({ ...toSearchSummary(message), account: runtime.id })));
      } catch (e) { return failure(e); }
    }
  );

  server.registerTool(
    'get_email',
    {
      description: 'Read one email using a stable message_ref. The account is inferred from new message references; account may be supplied to validate or route legacy references.',
      inputSchema: z.object({
        account: accountId,
        message_ref: z.string().min(1),
        include_html: z.boolean().default(false)
      }),
      annotations: { readOnlyHint: true }
    },
    async ({ account, message_ref, include_html }) => {
      try {
        const runtime = accounts.resolveForMessage(message_ref, account);
        const view = toEmailView(await runtime.imap.getEmail(message_ref), include_html);
        return result({ ...view, account: runtime.id });
      } catch (e) { return failure(e); }
    }
  );

  server.registerTool(
    'get_thread',
    {
      description: 'Read a mail thread within one account across Inbox and Sent. message_ref selects its owning account automatically; participant searches use account or the default account.',
      inputSchema: z.object({
        account: accountId,
        message_ref: z.string().optional(),
        participant: email.optional(),
        subject: z.string().optional(),
        include_html: z.boolean().default(false)
      }).refine((v) => !!v.message_ref || !!v.participant, 'message_ref or participant is required'),
      annotations: { readOnlyHint: true }
    },
    async ({ account, message_ref, participant, subject, include_html }) => {
      try {
        const runtime = message_ref
          ? accounts.resolveForMessage(message_ref, account)
          : accounts.resolve(account);
        const thread = await runtime.imap.getThread({ messageRef: message_ref, participant, subject });
        return result({
          account: runtime.id,
          heuristic: thread.heuristic,
          messages: thread.messages.map((message) => ({ ...toEmailView(message, include_html), account: runtime.id }))
        });
      } catch (e) { return failure(e); }
    }
  );

  server.registerTool(
    'send_email',
    {
      description: 'Send one new outreach email from one configured mail account. account defaults to the configured default account. idempotency is isolated per account.',
      inputSchema: z.object({
        account: accountId,
        to: primaryRecipient,
        cc: z.array(email).max(10).optional(),
        bcc: z.array(email).max(10).optional(),
        subject,
        text: z.string().min(1),
        html: z.string().optional(),
        reply_to: email.optional(),
        idempotency_key: idempotencyKey
      }),
      annotations: { readOnlyHint: false, destructiveHint: false }
    },
    async (a) => {
      try {
        const runtime = accounts.resolve(a.account);
        const message = {
          to: a.to,
          cc: a.cc,
          bcc: a.bcc,
          subject: a.subject,
          text: a.text,
          html: a.html,
          replyTo: a.reply_to
        };
        const sendResult = await idempotency.execute(
          scopedKey(runtime.id, 'send_email', a.idempotency_key),
          message,
          () => runtime.smtp.send(message)
        );
        return result({ account: runtime.id, ...sendResult });
      } catch (e) { return failure(e); }
    }
  );

  server.registerTool(
    'reply_email',
    {
      description: 'Reply from the same mail account that owns message_ref while preserving RFC thread headers. Supplying a different account is rejected.',
      inputSchema: z.object({
        account: accountId,
        message_ref: z.string().min(1),
        text: z.string().min(1),
        html: z.string().optional(),
        reply_all: z.boolean().default(false),
        idempotency_key: idempotencyKey
      }),
      annotations: { readOnlyHint: false, destructiveHint: false }
    },
    async (a) => {
      try {
        const runtime = accounts.resolveForMessage(a.message_ref, a.account);
        const payload = {
          account: runtime.id,
          messageRef: a.message_ref,
          text: a.text,
          html: a.html,
          replyAll: a.reply_all
        };
        const sendResult = await idempotency.execute(
          scopedKey(runtime.id, 'reply_email', a.idempotency_key),
          payload,
          async () => {
            const parent = await runtime.imap.getEmail(a.message_ref);
            return runtime.smtp.send(buildReplyMessage(parent, {
              text: a.text,
              html: a.html,
              replyAll: a.reply_all
            }, runtime.address));
          }
        );
        return result({ account: runtime.id, ...sendResult });
      } catch (e) { return failure(e); }
    }
  );

  const batchSchema = z.object({
    account: accountId,
    messages: z.array(z.object({
      to: primaryRecipient,
      cc: z.array(email).max(10).optional(),
      bcc: z.array(email).max(10).optional(),
      subject,
      text: z.string().min(1),
      html: z.string().optional()
    })).min(1).max(25),
    max: z.number().int().min(1).max(25).optional(),
    allow_duplicates: z.boolean().default(false),
    delay_ms: z.number().int().min(0).max(5000).default(250),
    retry_transient: z.boolean().default(false),
    retry_delay_ms: z.number().int().min(0).max(10000).default(1000),
    dry_run: z.boolean().default(false),
    idempotency_key: idempotencyKey.optional()
  }).refine((value) => value.dry_run || Boolean(value.idempotency_key), {
    message: 'idempotency_key is required when dry_run is false.',
    path: ['idempotency_key']
  });

  server.registerTool(
    'send_email_batch',
    {
      description: 'Preflight or send separate personalized messages from one configured account. One batch cannot mix sender accounts. Real sends require idempotency_key.',
      inputSchema: batchSchema,
      annotations: { readOnlyHint: false, destructiveHint: false }
    },
    async ({ account, messages, max, allow_duplicates, delay_ms, retry_transient, retry_delay_ms, dry_run, idempotency_key }) => {
      try {
        const runtime = accounts.resolve(account);
        const options = {
          max,
          allowDuplicates: allow_duplicates,
          delayMs: delay_ms,
          retryTransient: retry_transient,
          retryDelayMs: retry_delay_ms
        };
        if (dry_run) {
          return result({ account: runtime.id, dryRun: true, results: preflightBatch(messages, options) });
        }

        const payload = { account: runtime.id, messages, options };
        const batchResults = await idempotency.execute(
          scopedKey(runtime.id, 'send_email_batch', idempotency_key!),
          payload,
          () => executeBatch(messages, (m) => runtime.smtp.send(m), options)
        );
        return result({ account: runtime.id, dryRun: false, results: batchResults });
      } catch (e) { return failure(e); }
    }
  );
}
