import type { NormalizedMessage, ThreadResult } from './types.js';

export function normalizeSubject(subject: string): string {
  let value = subject.trim();
  while (/^(re|fw|fwd)\s*:/i.test(value)) value = value.replace(/^(re|fw|fwd)\s*:\s*/i, '').trim();
  return value;
}

export function buildReplyHeaders(parent: Pick<NormalizedMessage, 'messageId' | 'references'>): { inReplyTo?: string; references: string[] } {
  const references = [...parent.references];
  if (parent.messageId && !references.includes(parent.messageId)) references.push(parent.messageId);
  return { inReplyTo: parent.messageId ?? undefined, references: [...new Set(references)] };
}

function participants(message: NormalizedMessage): Set<string> {
  return new Set([...message.from, ...message.to, ...message.cc]);
}

export function resolveThread(messages: NormalizedMessage[], anchor: NormalizedMessage): ThreadResult {
  const ids = new Set<string>();
  if (anchor.messageId) ids.add(anchor.messageId);
  for (const ref of anchor.references) ids.add(ref);
  if (anchor.inReplyTo) ids.add(anchor.inReplyTo);

  if (ids.size > 0) {
    let changed = true;
    const matched = new Set<string>();
    while (changed) {
      changed = false;
      for (const m of messages) {
        const touches = (m.messageId && ids.has(m.messageId)) || (m.inReplyTo && ids.has(m.inReplyTo)) || m.references.some((r) => ids.has(r));
        if (touches && !matched.has(m.id)) {
          matched.add(m.id);
          if (m.messageId && !ids.has(m.messageId)) { ids.add(m.messageId); changed = true; }
          for (const r of m.references) if (!ids.has(r)) { ids.add(r); changed = true; }
        }
      }
    }
    if (matched.size > 1) {
      return {
        messages: messages.filter((m) => matched.has(m.id)).sort((a, b) => a.date.getTime() - b.date.getTime()),
        heuristic: false
      };
    }
  }

  const subject = normalizeSubject(anchor.subject).toLowerCase();
  const anchorPeople = participants(anchor);
  const heuristic = messages.filter((m) => normalizeSubject(m.subject).toLowerCase() === subject && [...participants(m)].some((p) => anchorPeople.has(p)));
  return { messages: heuristic.sort((a, b) => a.date.getTime() - b.date.getTime()), heuristic: true };
}
