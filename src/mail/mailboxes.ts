export interface MailboxDescriptor {
  path: string;
  specialUse: string | null;
}

export function pickMailboxBySpecialUse(
  mailboxes: MailboxDescriptor[],
  specialUse: string,
  fallbackNames: string[] = []
): string | null {
  const expected = specialUse.toLowerCase();
  const special = mailboxes.find((box) => box.specialUse?.toLowerCase() === expected);
  if (special) return special.path;

  const fallbackSet = new Set(fallbackNames.map((name) => name.trim().toLowerCase()));
  const fallback = mailboxes.find((box) => fallbackSet.has(box.path.trim().toLowerCase()));
  return fallback?.path ?? null;
}

export function resolveMailboxAlias(requested: string | undefined, mailboxes: MailboxDescriptor[]): string {
  const value = requested?.trim() || 'INBOX';
  const upper = value.toUpperCase();

  if (upper === 'INBOX' || upper === '\\INBOX') {
    return pickMailboxBySpecialUse(mailboxes, '\\Inbox', ['INBOX']) ?? 'INBOX';
  }

  if (upper === 'SENT' || upper === '\\SENT') {
    const sent = pickMailboxBySpecialUse(mailboxes, '\\Sent', ['Sent', 'Sent Messages', '已发送', '已发送邮件']);
    if (!sent) throw new Error('Sent mailbox was not found.');
    return sent;
  }

  return value;
}
