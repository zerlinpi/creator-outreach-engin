import { pickMailboxBySpecialUse, SENT_FALLBACK_NAMES } from './mail/mailboxes.js';
import type { ImapMailClient } from './mail/imap-client.js';
import type { SmtpMailClient } from './mail/smtp-client.js';

export interface MailDiagnosticsResult {
  ok: boolean;
  imap: {
    ok: boolean;
    mailboxCount: number;
    sentMailbox: string | null;
  };
  smtp: {
    ok: boolean;
  };
  warnings: string[];
}

export async function runMailDiagnostics(
  imap: Pick<ImapMailClient, 'listMailboxes'>,
  smtp: Pick<SmtpMailClient, 'verifyConnection'>
): Promise<MailDiagnosticsResult> {
  let mailboxes: Awaited<ReturnType<ImapMailClient['listMailboxes']>> = [];
  let imapOk = false;
  let smtpOk = false;
  const warnings: string[] = [];

  try {
    mailboxes = await imap.listMailboxes();
    imapOk = true;
  } catch {
    imapOk = false;
  }

  const sentMailbox = imapOk
    ? pickMailboxBySpecialUse(mailboxes, '\\Sent', SENT_FALLBACK_NAMES)
    : null;

  if (imapOk && !sentMailbox) {
    warnings.push('No provider-designated Sent mailbox was found; thread history and follow-up lookup may be incomplete.');
  }

  try {
    smtpOk = await smtp.verifyConnection();
  } catch {
    smtpOk = false;
  }

  return {
    ok: imapOk && smtpOk && Boolean(sentMailbox),
    imap: {
      ok: imapOk,
      mailboxCount: mailboxes.length,
      sentMailbox
    },
    smtp: { ok: smtpOk },
    warnings
  };
}
