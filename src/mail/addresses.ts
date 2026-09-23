import { ConnectorError } from '../errors.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_CHARS = 320;

export function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}

export function validateAddressList(values: string[]): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = normalizeAddress(raw);
    if (value.length > MAX_EMAIL_CHARS || !EMAIL.test(value)) {
      throw new ConnectorError('INVALID_ADDRESS', 'One or more email addresses are invalid.');
    }
    if (!seen.has(value)) {
      seen.add(value);
      unique.push(value);
    }
  }
  if (unique.length === 0) throw new ConnectorError('INVALID_ADDRESS', 'At least one recipient is required.');
  return unique;
}
