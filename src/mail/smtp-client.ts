import nodemailer from 'nodemailer';
import type { AppConfig } from '../config.js';
import { ConnectorError } from '../errors.js';
import { validateAddressList } from './addresses.js';
import type { OutgoingMessage, SendResult } from './types.js';

export class SmtpMailClient {
  private readonly transport;
  constructor(private readonly config: AppConfig) {
    this.transport = nodemailer.createTransport({ host: config.smtp.host, port: config.smtp.port, secure: true, auth: { user: config.username, pass: config.appPassword } });
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    const to = validateAddressList(message.to);
    try {
      const info = await this.transport.sendMail({
        from: { name: this.config.fromName, address: this.config.username },
        to,
        cc: message.cc,
        bcc: message.bcc,
        subject: message.subject,
        text: message.text,
        html: message.html,
        replyTo: message.replyTo,
        inReplyTo: message.inReplyTo,
        references: message.references
      });
      return { accepted: info.accepted.map(String), rejected: info.rejected.map(String), messageId: info.messageId };
    } catch (error) { throw new ConnectorError('SMTP_UNAVAILABLE', 'Message could not be sent.', { cause: error }); }
  }
}
