# Creator Outreach Engine

A small remote MCP mail connector for CAMPX creator outreach. It is designed to be called from a ChatGPT conversation, not used as a standalone CRM.

## What it exposes

Seven MCP tools: `list_mailboxes`, `search_emails`, `get_email`, `get_thread`, `send_email`, `reply_email`, and `send_email_batch`.

`send_email_batch` sends separate emails per creator. It never turns a creator list into one CC/BCC blast. Default batch limit is 10; hard limit is 25.

## Alibaba Mail configuration

Use an Alibaba enterprise mailbox third-party client/app password where available. Do not commit credentials.

```bash
cp .env.example .env
```

Required secrets:

- `MAIL_USERNAME` — full CAMPX enterprise email address.
- `MAIL_APP_PASSWORD` — third-party/app password.
- `CONNECTOR_AUTH_TOKEN` — a random bearer token of at least 16 characters.

Defaults are TLS-only: IMAP `imap.qiye.aliyun.com:993`, SMTP `smtp.qiye.aliyun.com:465`.

## Run locally

```bash
npm install
npm test
npm run typecheck
npm run build
MAIL_USERNAME=... MAIL_APP_PASSWORD=... CONNECTOR_AUTH_TOKEN=... npm start
```

Health: `GET /health`.
MCP: `POST /mcp` with `Authorization: Bearer <CONNECTOR_AUTH_TOKEN>`.

## Chat examples

- “查一下 Happily Ever Hanks 有没有回复 CAMPX。”
- “把我们跟 creator@example.com 最近的完整往来给我。”
- “回复这一封，说明我们通常是 8%，最高 10%，量大可以另外谈。”
- “给这 8 个红人分别发送以下邮件，每个人独立一封。”

## Deployment

Deploy as a Node.js 22 service or Docker container with outbound TCP access to IMAP 993 and SMTP 465. Inject secrets through the deployment platform; never bake `.env` into the image.

Register the resulting HTTPS `/mcp` endpoint as a custom MCP app/connector in a ChatGPT workspace that allows the required read/write actions. The repository contains the connector server only; ChatGPT account/workspace permissions determine whether write tools such as `send_email` can be invoked directly from chat.

## Safety notes

- Production email bodies and credentials are not intentionally logged.
- Batch messages are validated before sending.
- Replies preserve `In-Reply-To` and `References` where the parent message provides a `Message-ID`.
- Real mailbox network verification should be done with an owned test inbox before enabling creator outreach.
