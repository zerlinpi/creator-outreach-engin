export const MAIL_TOOLS = {
  listMailboxes: 'list_mailboxes',
  searchEmails: 'search_emails',
  getEmail: 'get_email',
  getThread: 'get_thread',
  sendEmail: 'send_email',
  replyEmail: 'reply_email',
  sendEmailBatch: 'send_email_batch',
} as const;

export const MAIL_TOOL_NAMES = Object.values(MAIL_TOOLS);
