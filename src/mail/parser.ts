import PostalMime from 'postal-mime';
import { normalizeParsedEmail } from './parser-normalize.ts';
import type { NormalizedMessage } from './types.ts';

export async function parseMessage(
  source: Buffer | Uint8Array | ArrayBuffer | string,
  meta: { mailbox: string; uid: number; unread?: boolean },
): Promise<NormalizedMessage> {
  const parsed = await PostalMime.parse(source);
  return normalizeParsedEmail(parsed, meta);
}
