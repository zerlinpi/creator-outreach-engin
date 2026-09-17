export interface MailAddress {
  name?: string;
  address: string;
}

export interface AttachmentMeta {
  filename?: string;
  contentType?: string;
  size?: number;
  contentId?: string;
}

export interface NormalizedMessage {
  connectorId: string;
  mailbox: string;
  uid: number;
  messageId?: string;
  inReplyTo?: string;
  references: string[];
  subject: string;
  from?: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  date?: string;
  unread?: boolean;
  text: string;
  html?: string;
  attachments: AttachmentMeta[];
}

export interface ThreadResult {
  heuristic: boolean;
  messages: NormalizedMessage[];
}

export interface SearchCriteria {
  query?: string;
  from?: string;
  to?: string;
  subject?: string;
  mailbox?: string;
  unread?: boolean;
  since?: string;
  before?: string;
  limit?: number;
}

export interface MessageSummary {
  connectorId: string;
  mailbox: string;
  uid: number;
  messageId?: string;
  from?: MailAddress;
  to: MailAddress[];
  subject: string;
  date?: string;
  unread?: boolean;
}

export interface OutgoingMessage {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  inReplyTo?: string;
  references?: string[];
}

export interface SendResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
  response?: string;
}
