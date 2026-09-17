import { timingSafeEqual } from 'node:crypto';

export function isAuthorizedBearer(header: string | undefined, expectedToken: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const supplied = header.slice('Bearer '.length).trim();
  if (!supplied || !expectedToken) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expectedToken);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
