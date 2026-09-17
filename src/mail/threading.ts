import type { NormalizedMessage, ThreadResult } from './types.ts';

const PREFIX = /^\s*(?:(?:re|fw|fwd)\s*:\s*)+/i;

export function normalizeSubject(subject: string): string {
  return subject.replace(PREFIX, '').replace(/\s+/g, ' ').trim();
}

function unique(values: Array<string | undefined>): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

export function buildReplyHeaders(parent: NormalizedMessage): {
  subject: string;
  inReplyTo?: string;
  references: string[];
} {
  const baseSubject = normalizeSubject(parent.subject);
  return {
    subject: baseSubject ? `Re: ${baseSubject}` : 'Re:',
    inReplyTo: parent.messageId,
    references: unique([...parent.references, parent.messageId]),
  };
}

function identifiers(message: NormalizedMessage): Set<string> {
  return new Set(unique([message.messageId, message.inReplyTo, ...message.references]));
}

function participants(message: NormalizedMessage): Set<string> {
  const values = [message.from?.address, ...message.to.map((a) => a.address), ...message.cc.map((a) => a.address)]
    .filter((v): v is string => Boolean(v))
    .map((v) => v.toLowerCase());
  return new Set(values);
}

function intersects<T>(a: Set<T>, b: Set<T>): boolean {
  for (const value of a) if (b.has(value)) return true;
  return false;
}

function sortMessages(messages: NormalizedMessage[]): NormalizedMessage[] {
  return [...messages].sort((a, b) => {
    const ad = a.date ? Date.parse(a.date) : 0;
    const bd = b.date ? Date.parse(b.date) : 0;
    if (ad !== bd) return ad - bd;
    return a.uid - b.uid;
  });
}

export function resolveThread(messages: NormalizedMessage[], seed: NormalizedMessage): ThreadResult {
  const seedIds = identifiers(seed);
  if (seedIds.size > 0) {
    const selected = new Map<string, NormalizedMessage>();
    const known = new Set(seedIds);
    selected.set(seed.connectorId, seed);

    let changed = true;
    while (changed) {
      changed = false;
      for (const message of messages) {
        if (selected.has(message.connectorId)) continue;
        const ids = identifiers(message);
        if (intersects(ids, known)) {
          selected.set(message.connectorId, message);
          for (const id of ids) known.add(id);
          changed = true;
        }
      }
    }
    return { heuristic: false, messages: sortMessages([...selected.values()]) };
  }

  const subject = normalizeSubject(seed.subject).toLowerCase();
  const seedParticipants = participants(seed);
  const seedDate = seed.date ? Date.parse(seed.date) : undefined;
  const windowMs = 45 * 24 * 60 * 60 * 1000;

  const fallback = messages.filter((message) => {
    if (normalizeSubject(message.subject).toLowerCase() !== subject) return false;
    if (!intersects(seedParticipants, participants(message))) return false;
    if (seedDate === undefined || !message.date) return true;
    return Math.abs(Date.parse(message.date) - seedDate) <= windowMs;
  });

  if (!fallback.some((m) => m.connectorId === seed.connectorId)) fallback.push(seed);
  return { heuristic: true, messages: sortMessages(fallback) };
}
