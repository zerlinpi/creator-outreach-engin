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
