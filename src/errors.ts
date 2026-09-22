export type ConnectorErrorCode =
  | 'AUTH_FAILED'
  | 'IMAP_UNAVAILABLE'
  | 'SMTP_UNAVAILABLE'
  | 'MESSAGE_NOT_FOUND'
  | 'MESSAGE_TOO_LARGE'
  | 'MAILBOX_NOT_FOUND'
  | 'ACCOUNT_NOT_FOUND'
  | 'ACCOUNT_MISMATCH'
  | 'INVALID_ADDRESS'
  | 'THREAD_NOT_FOUND'
  | 'RECIPIENT_REJECTED'
  | 'RATE_LIMITED'
  | 'TRANSIENT_MAIL_ERROR'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INTERNAL_ERROR';

export interface SafeToolError {
  code: ConnectorErrorCode;
  message: string;
}

export class ConnectorError extends Error {
  constructor(public readonly code: ConnectorErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConnectorError';
  }
}

export function toSafeError(error: unknown): SafeToolError {
  if (error instanceof ConnectorError) {
    return { code: error.code, message: error.message };
  }
  return { code: 'INTERNAL_ERROR', message: 'The connector could not complete the request.' };
}
