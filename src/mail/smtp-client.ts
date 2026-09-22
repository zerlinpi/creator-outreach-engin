import nodemailer from 'nodemailer';
import type { SendMailOptions } from 'nodemailer';
import type { MailRuntimeConfig } from '../config.js';
import { ConnectorError } from '../errors.js';
import { normalizeAddress, validateAddressList } from './addresses.js';
import type { OutgoingMessage, SendResult } from './types.js';

interface MailTransport {
  sendMail(options: SendMailOptions): Promise<{
    accepted: unknown[];
    rejected: unknown[];
    messageId: string;
  }>;
  verify?(): Promise<boolean>;
}

const MAX_ENVELOPE_RECIPIENTS = 21;

export function buildSmtpTransportOptions(config: MailRuntimeConfig) {
  return {
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    ...(config.smtp.requireTLS ? { requireTLS: true } : {}),
    auth: { user: config.username, pass: config.appPassword },
    connectionTimeout: config.smtp.connectionTimeout,
    greetingTimeout: config.smtp.greetingTimeout,
    socketTimeout: config.smtp.socketTimeout
  };
}

function optionalAddresses(values?: string[]): string[] | undefined {
  if (!values?.length) return undefined;
  return validateAddressList(values);
}

function enforceEnvelopeRecipientLimit(to: string[], cc?: string[], bcc?: string[]): void {
  const recipients = new Set([...to, ...(cc ?? []), ...(bcc ?? [])]);
  if (recipients.size > MAX_ENVELOPE_RECIPIENTS) {
    throw new ConnectorError(
      'RATE_LIMITED',
      'Message has too many unique recipients (max ' + MAX_ENVELOPE_RECIPIENTS + ').'
    );
  }
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
  private sendTail: Promise<void> = Promise.resolve();
  private enabled = true;

  constructor(private readonly config: MailRuntimeConfig, transport?: MailTransport) {
    this.transport = transport ?? (nodemailer.createTransport(buildSmtpTransportOptions(config)) as MailTransport);
  }

  disable(): void {
    this.enabled = false;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.sendTail.then(operation, operation);
    this.sendTail = run.then(() => undefined, () => undefined);
    return run;
  }

  async verifyConnection(): Promise<boolean> {
    if (!this.transport.verify) {
      throw new ConnectorError('SMTP_UNAVAILABLE', 'SMTP connection verification is unavailable.');
    }
    if (!this.enabled) throw new ConnectorError('ACCOUNT_NOT_FOUND', 'Mail account configuration changed or was removed.');
    try {
      return await this.transport.verify();
    } catch (error) {
      throw classifySmtpError(error);
    }
  }

  send(message: OutgoingMessage): Promise<SendResult> {
    return this.enqueue(async () => {
      if (!this.enabled) throw new ConnectorError('ACCOUNT_NOT_FOUND', 'Mail account configuration changed or was removed.');
      const to = validateAddressList(message.to);
      const cc = optionalAddresses(message.cc);
      const bcc = optionalAddresses(message.bcc);
      const replyTo = message.replyTo ? validateAddressList([message.replyTo])[0] : undefined;
      enforceEnvelopeRecipientLimit(to, cc, bcc);

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
        const acceptedAddresses = new Set(accepted.map(normalizeAddress));
        const missingPrimary = to.filter((address) => !acceptedAddresses.has(address));

        if (missingPrimary.length > 0) {
          throw new ConnectorError('RECIPIENT_REJECTED', 'Mail provider did not accept the primary recipient.');
        }

        return { accepted, rejected, messageId: info.messageId };
      } catch (error) {
        if (error instanceof ConnectorError) throw error;
        throw classifySmtpError(error);
      }
    });
  }
}
