import { ConnectorError } from '../errors.ts';

export function encodeMessageRef(mailbox: string, uid: number): string {
  const payload = Buffer.from(JSON.stringify({ mailbox, uid }), 'utf8').toString('base64url');
  return `mref_${payload}`;
}

export function decodeMessageRef(ref: string): { mailbox: string; uid: number } {
  try {
    if (!ref.startsWith('mref_')) throw new Error('prefix');
    const parsed = JSON.parse(Buffer.from(ref.slice(5), 'base64url').toString('utf8')) as { mailbox?: unknown; uid?: unknown };
    if (typeof parsed.mailbox !== 'string' || !parsed.mailbox.trim() || !Number.isInteger(parsed.uid) || Number(parsed.uid) <= 0) {
      throw new Error('shape');
    }
    return { mailbox: parsed.mailbox, uid: Number(parsed.uid) };
  } catch {
    throw new ConnectorError('MESSAGE_NOT_FOUND', 'Invalid message reference');
  }
}
