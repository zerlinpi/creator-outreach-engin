import { describe, expect, it } from 'vitest';
import { ConnectorError, toSafeError } from '../../src/errors.js';

describe('safe errors', () => {
  it('preserves connector code and safe message', () => {
    const error = new ConnectorError('INVALID_ADDRESS', 'Recipient address is invalid');
    expect(toSafeError(error)).toEqual({ code: 'INVALID_ADDRESS', message: 'Recipient address is invalid' });
  });

  it('does not expose raw unknown error details or stack traces', () => {
    const error = new Error('MAIL_APP_PASSWORD=super-secret');
    const safe = toSafeError(error);
    expect(JSON.stringify(safe)).not.toContain('super-secret');
    expect(JSON.stringify(safe)).not.toContain('MAIL_APP_PASSWORD');
    expect(safe.code).toBe('INTERNAL_ERROR');
  });
});
