import { timingSafeEqual } from 'node:crypto';

export function isAuthorized(header: string | undefined, expectedToken: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const token = header.slice(7);
  const a = Buffer.from(token);
  const b = Buffer.from(expectedToken);
  return a.length === b.length && timingSafeEqual(a, b);
}
