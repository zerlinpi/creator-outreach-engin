import { ConnectorError } from '../errors.ts';

const SIMPLE_EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export function normalizeAddress(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!SIMPLE_EMAIL.test(normalized)) {
    throw new ConnectorError('INVALID_ADDRESS', `Invalid email address: ${value}`);
  }
  return normalized;
}

export function validateAddressList(values: string[], options: { allowEmpty?: boolean } = {}): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeAddress(value);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  if (!options.allowEmpty && result.length === 0) {
    throw new ConnectorError('INVALID_ADDRESS', 'At least one recipient is required');
  }
  return result;
}
