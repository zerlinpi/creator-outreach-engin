export interface AttachmentMeta {
  filename: string | null;
  contentType: string;
  size: number;
  contentDisposition: string | null;
  cid: string | null;
}

export interface NormalizedMessage {
  id: string;
  mailbox: string;
  uid: number;
  from: string[];
  replyTo?: string[];
  to: string[];
  cc: string[];
  subject: string;
  date: Date;
  text: string;
  html: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  attachments: AttachmentMeta[];
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
  accepted: string[];
  rejected: string[];
  messageId: string;
}

export interface ThreadResult {
  messages: NormalizedMessage[];
  heuristic: boolean;
}
