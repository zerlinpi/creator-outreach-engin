import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';
import type { ImapMailClient } from '../mail/imap-client.js';
import type { SmtpMailClient } from '../mail/smtp-client.js';
import { buildReplyMessage } from '../mail/reply.js';
import { executeBatch } from '../mail/batch.js';
import { toSafeError } from '../errors.js';

const email = z.string().email();
const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
const failure = (error: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ error: toSafeError(error) }) }], isError: true });

export function registerMailTools(server: McpServer, imap: ImapMailClient, smtp: SmtpMailClient, mailboxAddress: string) {
  server.registerTool('list_mailboxes', { description: 'List folders in the connected CAMPX mailbox.', inputSchema: z.object({}), annotations: { readOnlyHint: true } }, async () => { try { return result(await imap.listMailboxes()); } catch (e) { return failure(e); } });

  server.registerTool('search_emails', { description: 'Search CAMPX email by sender, recipient, subject, date, unread state, or text. Use this before asking the user to paste an email.', inputSchema: z.object({ query: z.string().optional(), from: email.optional(), to: email.optional(), subject: z.string().optional(), mailbox: z.string().optional(), unread: z.boolean().optional(), since: z.string().datetime().optional(), before: z.string().datetime().optional(), limit: z.number().int().min(1).max(100).optional() }), annotations: { readOnlyHint: true } }, async (a) => { try { return result(await imap.searchEmails({ ...a, since: a.since ? new Date(a.since) : undefined, before: a.before ? new Date(a.before) : undefined })); } catch (e) { return failure(e); } });

  server.registerTool('get_email', { description: 'Read one email using the stable message reference returned by search_emails.', inputSchema: z.object({ message_ref: z.string().min(1) }), annotations: { readOnlyHint: true } }, async ({ message_ref }) => { try { return result(await imap.getEmail(message_ref)); } catch (e) { return failure(e); } });

  server.registerTool('get_thread', { description: 'Read the full mail thread for a known message or creator participant.', inputSchema: z.object({ message_ref: z.string().optional(), participant: email.optional(), subject: z.string().optional() }).refine((v) => !!v.message_ref || !!v.participant, 'message_ref or participant is required'), annotations: { readOnlyHint: true } }, async ({ message_ref, participant, subject }) => { try { return result(await imap.getThread({ messageRef: message_ref, participant, subject })); } catch (e) { return failure(e); } });

  server.registerTool('send_email', { description: 'Send a new CAMPX outreach email. Each creator should normally receive a separate message.', inputSchema: z.object({ to: z.array(email).min(1), cc: z.array(email).optional(), bcc: z.array(email).optional(), subject: z.string().min(1), text: z.string().min(1), html: z.string().optional(), reply_to: email.optional() }), annotations: { readOnlyHint: false, destructiveHint: false } }, async (a) => { try { return result(await smtp.send({ to: a.to, cc: a.cc, bcc: a.bcc, subject: a.subject, text: a.text, html: a.html, replyTo: a.reply_to })); } catch (e) { return failure(e); } });

  server.registerTool('reply_email', { description: 'Reply to an existing CAMPX email while preserving RFC mail-thread headers.', inputSchema: z.object({ message_ref: z.string().min(1), text: z.string().min(1), html: z.string().optional(), reply_all: z.boolean().default(false) }), annotations: { readOnlyHint: false, destructiveHint: false } }, async (a) => { try { const parent = await imap.getEmail(a.message_ref); return result(await smtp.send(buildReplyMessage(parent, { text: a.text, html: a.html, replyAll: a.reply_all }, mailboxAddress))); } catch (e) { return failure(e); } });

  server.registerTool('send_email_batch', { description: 'Send separate personalized outreach messages to multiple creators. This never converts recipients into a CC/BCC blast.', inputSchema: z.object({ messages: z.array(z.object({ to: z.array(email).min(1), cc: z.array(email).optional(), bcc: z.array(email).optional(), subject: z.string().min(1), text: z.string().min(1), html: z.string().optional() })).min(1).max(25), max: z.number().int().min(1).max(25).optional(), allow_duplicates: z.boolean().default(false) }), annotations: { readOnlyHint: false, destructiveHint: false } }, async ({ messages, max, allow_duplicates }) => { try { return result(await executeBatch(messages, (m) => smtp.send(m), { max, allowDuplicates: allow_duplicates })); } catch (e) { return failure(e); } });
}
