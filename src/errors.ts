export type ConnectorErrorCode =
  | 'AUTH_FAILED'
  | 'IMAP_UNAVAILABLE'
  | 'SMTP_UNAVAILABLE'
  | 'MESSAGE_NOT_FOUND'
  | 'MAILBOX_NOT_FOUND'
  | 'INVALID_ADDRESS'
  | 'THREAD_NOT_FOUND'
  | 'RECIPIENT_REJECTED'
  | 'RATE_LIMITED'
  | 'TRANSIENT_MAIL_ERROR'
  | 'INTERNAL_ERROR';

export interface SafeToolError {
  code: ConnectorErrorCode;
  message: string;
}

export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode;
  readonly details?: unknown;

  constructor(code: ConnectorErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ConnectorError';
    this.code = code;
    this.details = details;
  }
}

export function toSafeError(error: unknown): SafeToolError {
  if (error instanceof ConnectorError) {
    return { code: error.code, message: error.message };
  }
  return { code: 'INTERNAL_ERROR', message: 'Internal connector error' };
}
