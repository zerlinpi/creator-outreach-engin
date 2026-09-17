import nodemailer from 'nodemailer';
import type { SendMailOptions } from 'nodemailer';
import type { AppConfig } from '../config.js';
import { ConnectorError } from '../errors.js';
import { validateAddressList } from './addresses.js';
import type { OutgoingMessage, SendResult } from './types.js';

interface MailTransport {
  sendMail(options: SendMailOptions): Promise<{
    accepted: unknown[];
    rejected: unknown[];
    messageId: string;
  }>;
}

export function buildSmtpTransportOptions(config: AppConfig) {
  return {
    host: config.smtp.host,
    port: config.smtp.port,
    secure: true,
    auth: { user: config.username, pass: config.appPassword }
  };
}

function optionalAddresses(values?: string[]): string[] | undefined {
  if (!values?.length) return undefined;
  return validateAddressList(values);
}

function classifySmtpError(error: unknown): ConnectorError {
  const value = error as { code?: string; responseCode?: number } | undefined;
  const transientCodes = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ESOCKET', 'ENETUNREACH']);

  if (value?.code === 'EAUTH' || value?.responseCode === 535 || value?.responseCode === 526) {
    return new ConnectorError('AUTH_FAILED', 'Mailbox authentication failed.', { cause: error });
  }
  if (value?.responseCode === 429 || value?.responseCode === 421) {
    return new ConnectorError('RATE_LIMITED', 'Mail provider temporarily rate-limited or deferred the message.', { cause: error });
  }
  if (value?.responseCode === 450 || value?.responseCode === 451 || value?.responseCode === 452 || (value?.code && transientCodes.has(value.code))) {
    return new ConnectorError('TRANSIENT_MAIL_ERROR', 'Temporary mail transport failure.', { cause: error });
  }
  if (value?.responseCode && value.responseCode >= 550 && value.responseCode < 560) {
    return new ConnectorError('RECIPIENT_REJECTED', 'Mail provider permanently rejected the recipient or message.', { cause: error });
  }
  return new ConnectorError('SMTP_UNAVAILABLE', 'Message could not be sent.', { cause: error });
}

export class SmtpMailClient {
  private readonly transport: MailTransport;

  constructor(private readonly config: AppConfig, transport?: MailTransport) {
    this.transport = transport ?? (nodemailer.createTransport(buildSmtpTransportOptions(config)) as MailTransport);
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    const to = validateAddressList(message.to);
    const cc = optionalAddresses(message.cc);
    const bcc = optionalAddresses(message.bcc);
    const replyTo = message.replyTo ? validateAddressList([message.replyTo])[0] : undefined;

    try {
      const info = await this.transport.sendMail({
        from: { name: this.config.fromName, address: this.config.username },
        to,
        cc,
        bcc,
        subject: message.subject,
        text: message.text,
        html: message.html,
        replyTo,
        inReplyTo: message.inReplyTo,
        references: message.references
      });

      const accepted = info.accepted.map(String);
      const rejected = info.rejected.map(String);
      if (accepted.length === 0 && rejected.length > 0) {
        throw new ConnectorError('RECIPIENT_REJECTED', 'Mail provider rejected all recipients.');
      }

      return {
        accepted,
        rejected,
        messageId: info.messageId
      };
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw classifySmtpError(error);
    }
  }
}
