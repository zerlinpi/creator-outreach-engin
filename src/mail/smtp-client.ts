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
  if (value?.code === 'EAUTH' || value?.responseCode === 535 || value?.responseCode === 526) {
    return new ConnectorError('AUTH_FAILED', 'Mailbox authentication failed.', { cause: error });
  }
  if (value?.responseCode === 429 || value?.responseCode === 421 || value?.responseCode === 450 || value?.responseCode === 451 || value?.responseCode === 452) {
    return new ConnectorError('RATE_LIMITED', 'Mail provider temporarily refused the message.', { cause: error });
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

      return {
        accepted: info.accepted.map(String),
        rejected: info.rejected.map(String),
        messageId: info.messageId
      };
    } catch (error) {
      throw classifySmtpError(error);
    }
  }
}
