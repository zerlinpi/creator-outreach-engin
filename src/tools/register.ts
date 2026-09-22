import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';
import type { MailAccountRegistry } from '../mail/accounts.js';
import type { IdempotencyStore } from '../mail/idempotency.js';
import { buildReplyMessage } from '../mail/reply.js';
import { executeBatch, preflightBatch } from '../mail/batch.js';
import { toEmailView, toSearchSummary } from '../mail/presenters.js';
import { ConnectorError, toSafeError } from '../errors.js';
import type { OutgoingMessage } from '../mail/types.js';

const email = z.string().email();
const accountId = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
const optionalAccountId = accountId.optional();
const primaryRecipient = z.array(email).length(1);
const subject = z.string().min(1).max(200).refine((value) => !/[\r\n]/.test(value), 'Subject must not contain CR or LF characters.');
const idempotencyKey = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
const failure = (error: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ error: toSafeError(error) }) }], isError: true });

function scopedKey(account: string, operation: string, key: string): string {
  return 'account:' + account + ':' + operation + ':' + key;
}

export function registerMailTools(server: McpServer, accounts: MailAccountRegistry, idempotency: IdempotencyStore) {
  server.registerTool(
    'list_mailboxes',
    {
      description: 'List configured mail accounts and their folders. With multiple accounts, returns explicit account id/address metadata so AI can keep mailboxes separate.',
      inputSchema: z.object({ account: optionalAccountId }),
      annotations: { readOnlyHint: true }
    },
    async ({ account }) => {
      try {
        if (account || accounts.size === 1) return result(await accounts.resolve(account).imap.listMailboxes());

        const rows = await Promise.all(accounts.list().map(async (runtime) => {
          try {
            return {
              account: runtime.id,
              address: runtime.address,
              fromName: runtime.fromName,
              source: runtime.source ?? 'environment',
              ok: true as const,
              mailboxes: await runtime.imap.listMailboxes()
            };
          } catch (error) {
            return {
              account: runtime.id,
              address: runtime.address,
              fromName: runtime.fromName,
              source: runtime.source ?? 'environment',
              ok: false as const,
              error: toSafeError(error)
            };
          }
        }));
        return result({ defaultAccount: accounts.defaultAccountId ?? null, accountCount: rows.length, accounts: rows });
      } catch (e) { return failure(e); }
    }
  );

  server.registerTool(
    'search_emails',
    {
      description: 'Search one mailbox or all configured mailboxes. Set all_accounts=true when the user asks to check every mailbox. All-account results always include account and accountAddress to prevent cross-mailbox confusion.',
      inputSchema: z.object({
        account: optionalAccountId,
        all_accounts: z.boolean().default(false),
        query: z.string().optional(),
        from: email.optional(),
        to: email.optional(),
        subject: z.string().optional(),
        mailbox: z.string().optional(),
        unread: z.boolean().optional(),
        since: z.string().datetime().optional(),
        before: z.string().datetime().optional(),
        limit: z.number().int().min(1).max(100).optional()
      }).refine((value) => !(value.all_accounts && value.account), 'account must be omitted when all_accounts is true'),
      annotations: { readOnlyHint: true }
    },
    async (a) => {
      try {
        const criteria = {
          query: a.query,
          from: a.from,
          to: a.to,
          subject: a.subject,
          mailbox: a.mailbox,
          unread: a.unread,
          since: a.since ? new Date(a.since) : undefined,
          before: a.before ? new Date(a.before) : undefined,
          limit: a.limit
        };

        if (a.all_accounts) {
          const runtimes = accounts.list();
          const searched = await Promise.all(runtimes.map(async (runtime) => {
            try {
              const messages = await runtime.imap.searchEmails(criteria);
              return {
                account: runtime.id,
                address: runtime.address,
                messages,
                error: undefined
              };
            } catch (error) {
              return {
                account: runtime.id,
                address: runtime.address,
                messages: [],
                error: toSafeError(error)
              };
            }
          }));

          const globalLimit = a.limit ?? 20;
          const results = searched
            .flatMap((entry) => entry.messages.map((message) => ({
              ...toSearchSummary(message),
              account: entry.account,
              accountAddress: entry.address
            })))
            .sort((left, right) => new Date(right.date).getTime() - new Date(left.date).getTime())
            .slice(0, globalLimit);

          return result({
            scope: 'all_accounts',
            searchedAccounts: searched.map((entry) => ({ account: entry.account, address: entry.address })),
            results,
            failures: searched.filter((entry) => entry.error).map((entry) => ({
              account: entry.account,
              address: entry.address,
              error: entry.error
            }))
          });
        }

        const runtime = accounts.resolve(a.account);
        const messages = await runtime.imap.searchEmails(criteria);
        return result(messages.map((message) => ({
          ...toSearchSummary(message),
          account: runtime.id,
          accountAddress: runtime.address
        })));
      } catch (e) { return failure(e); }
    }
  );

  server.registerTool(
    'get_email',
    {
      description: 'Read one email using a stable message_ref. New refs permanently bind the owning account; an explicit mismatched account is rejected.',
      inputSchema: z.object({
        account: optionalAccountId,
        message_ref: z.string().min(1),
        include_html: z.boolean().default(false)
      }),
      annotations: { readOnlyHint: true }
    },
    async ({ account, message_ref, include_html }) => {
      try {
        const runtime = accounts.resolveForMessage(message_ref, account);
        const view = toEmailView(await runtime.imap.getEmail(message_ref), include_html);
        return result({ ...view, account: runtime.id, accountAddress: runtime.address });
      } catch (e) { return failure(e); }
    }
  );

  server.registerTool(
    'get_thread',
    {
      description: 'Read a mail thread only inside its owning account. message_ref selects the account automatically so threads from different mailboxes cannot merge.',
      inputSchema: z.object({
        account: optionalAccountId,
        message_ref: z.string().optional(),
        participant: email.optional(),
        subject: z.string().optional(),
        include_html: z.boolean().default(false)
      }).refine((v) => !!v.message_ref || !!v.participant, 'message_ref or participant is required'),
      annotations: { readOnlyHint: true }
    },
    async ({ account, message_ref, participant, subject, include_html }) => {
      try {
        const runtime = message_ref ? accounts.resolveForMessage(message_ref, account) : accounts.resolve(account);
        const thread = await runtime.imap.getThread({ messageRef: message_ref, participant, subject });
        return result({
          account: runtime.id,
          accountAddress: runtime.address,
          heuristic: thread.heuristic,
          messages: thread.messages.map((message) => ({
            ...toEmailView(message, include_html),
            account: runtime.id,
            accountAddress: runtime.address
          }))
        });
      } catch (e) { return failure(e); }
    }
  );

  server.registerTool(
    'send_email',
    {
      description: 'Send one new email from exactly one configured account. The returned result always states the sender account.',
      inputSchema: z.object({
        account: optionalAccountId,
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
        const message = { to: a.to, cc: a.cc, bcc: a.bcc, subject: a.subject, text: a.text, html: a.html, replyTo: a.reply_to };
        const sendResult = await idempotency.execute(
          scopedKey(runtime.id, 'send_email', a.idempotency_key),
          message,
          () => runtime.smtp.send(message)
        );
        return result({ account: runtime.id, accountAddress: runtime.address, ...sendResult });
      } catch (e) { return failure(e); }
    }
  );

  server.registerTool(
    'reply_email',
    {
      description: 'Reply from the exact account that owns message_ref. Cross-account replies are rejected before SMTP.',
      inputSchema: z.object({
        account: optionalAccountId,
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
        const payload = { account: runtime.id, messageRef: a.message_ref, text: a.text, html: a.html, replyAll: a.reply_all };
        const sendResult = await idempotency.execute(
          scopedKey(runtime.id, 'reply_email', a.idempotency_key),
          payload,
          async () => {
            const parent = await runtime.imap.getEmail(a.message_ref);
            return runtime.smtp.send(buildReplyMessage(parent, { text: a.text, html: a.html, replyAll: a.reply_all }, runtime.address));
          }
        );
        return result({ account: runtime.id, accountAddress: runtime.address, ...sendResult });
      } catch (e) { return failure(e); }
    }
  );

  const batchMessage = z.object({
    account: optionalAccountId,
    to: primaryRecipient,
    cc: z.array(email).max(10).optional(),
    bcc: z.array(email).max(10).optional(),
    subject,
    text: z.string().min(1),
    html: z.string().optional()
  });

  const batchSchema = z.object({
    account: optionalAccountId,
    messages: z.array(batchMessage).min(1).max(25),
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
      description: 'Send a small batch from one or multiple mail accounts. For multi-account mode, omit top-level account and set account on every message. Different account groups run concurrently; messages within one account remain sequential. Multi-account results always include account.',
      inputSchema: batchSchema,
      annotations: { readOnlyHint: false, destructiveHint: false }
    },
    async ({ account, messages, max, allow_duplicates, delay_ms, retry_transient, retry_delay_ms, dry_run, idempotency_key }) => {
      try {
        const options = { max, allowDuplicates: allow_duplicates, delayMs: delay_ms, retryTransient: retry_transient, retryDelayMs: retry_delay_ms };
        const perMessageAccounts = messages.map((message) => message.account);
        const hasPerMessageAccount = perMessageAccounts.some(Boolean);

        if (!hasPerMessageAccount) {
          const runtime = accounts.resolve(account);
          const cleanMessages: OutgoingMessage[] = messages.map(({ account: _account, ...message }) => message);
          if (dry_run) return result(preflightBatch(cleanMessages, options));
          const payload = { account: runtime.id, messages: cleanMessages, options };
          return result(await idempotency.execute(
            scopedKey(runtime.id, 'send_email_batch', idempotency_key!),
            payload,
            () => executeBatch(cleanMessages, (message) => runtime.smtp.send(message), options)
          ));
        }

        if (account) throw new ConnectorError('ACCOUNT_MISMATCH', 'Top-level account must be omitted when messages specify sender accounts.');
        if (perMessageAccounts.some((value) => !value)) {
          throw new ConnectorError('ACCOUNT_MISMATCH', 'Every message must specify account in multi-account batch mode.');
        }

        const effectiveMax = max ?? 10;
        if (messages.length > effectiveMax) throw new ConnectorError('RATE_LIMITED', 'Batch contains too many messages (max ' + effectiveMax + ').');

        const groups = new Map<string, Array<{ index: number; message: OutgoingMessage }>>();
        messages.forEach(({ account: messageAccount, ...message }, index) => {
          const runtime = accounts.resolve(messageAccount!);
          const group = groups.get(runtime.id) ?? [];
          group.push({ index, message });
          groups.set(runtime.id, group);
        });

        const executeMulti = async () => {
          const groupedResults = await Promise.all([...groups.entries()].map(async ([accountIdValue, entries]) => {
            const runtime = accounts.resolve(accountIdValue);
            const groupOptions = { ...options, max: entries.length };
            if (dry_run) {
              return preflightBatch(entries.map((entry) => entry.message), groupOptions).map((item, offset) => ({
                ...item,
                index: entries[offset].index,
                account: runtime.id,
                accountAddress: runtime.address
              }));
            }
            const sent = await executeBatch(entries.map((entry) => entry.message), (message) => runtime.smtp.send(message), groupOptions);
            return sent.map((item, offset) => ({
              ...item,
              index: entries[offset].index,
              account: runtime.id,
              accountAddress: runtime.address
            }));
          }));
          return groupedResults.flat().sort((left, right) => left.index - right.index);
        };

        if (dry_run) return result(await executeMulti());

        const payload = {
          messages: messages.map((message) => ({ ...message })),
          options
        };
        return result(await idempotency.execute(
          'multi-account:send_email_batch:' + idempotency_key!,
          payload,
          executeMulti
        ));
      } catch (e) { return failure(e); }
    }
  );
}
