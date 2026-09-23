# Production deployment quickstart

This guide is for the current single-process production architecture. It keeps all existing MCP, Mailbox Manager, OAuth, IMAP, SMTP, and multi-mailbox behavior unchanged.

## 1. Choose one runtime

### Direct Node.js behind same-host Nginx

Use Node.js 22.12 or newer.

```bash
git pull
node --version
npm ci
npm run verify
cp -n .env.example .env
# edit .env, then:
npm run preflight:native
```

Minimum production values to edit in `.env`:

```env
NODE_ENV=production
PORT=3000
CONNECTOR_BIND_HOST=127.0.0.1
CONNECTOR_ALLOWED_HOSTS=mail.example.com,127.0.0.1

CONNECTOR_AUTH_TOKEN=<random-secret-at-least-32-characters>
MAIL_MESSAGE_REF_SIGNING_KEY=<independent-random-secret-at-least-32-characters>

MAIL_ADMIN_PASSWORD=<strong-password-at-least-16-characters>
MAIL_ACCOUNT_STORE_KEY=<random-secret-at-least-32-characters>
MAIL_ACCOUNT_STORE_PATH=./data/mail-accounts.enc.json
MAIL_MAX_ACCOUNTS=50
```

If ChatGPT OAuth will be used, also configure all three:

```env
OAUTH_ISSUER=https://mail.example.com
OAUTH_LOGIN_PASSWORD=<separate-strong-password>
OAUTH_SIGNING_SECRET=<random-secret-at-least-32-characters>
```

Start once in the foreground for the first deployment test:

```bash
npm start
```

The expected startup log includes the bind host, port, and configured mailbox count. A fresh Mailbox Manager deployment may start with zero mailboxes.

For aaPanel/BT Panel, PM2, systemd, working-directory requirements, file permissions, and native update steps, use `docs/NATIVE_DEPLOY.md`. The native preflight requires `NODE_ENV=production`, validates the compiled server/configuration, and checks that the Mailbox Manager data directory is writable by the actual service user.

### Docker behind same-host Nginx

Inside a container, bind Node to all container interfaces:

```env
NODE_ENV=production
PORT=3000
CONNECTOR_BIND_HOST=0.0.0.0
CONNECTOR_ALLOWED_HOSTS=mail.example.com,127.0.0.1
```

Do not use `CONNECTOR_BIND_HOST=127.0.0.1` inside Docker when the port is published from the container.

Build and run:

```bash
docker build -t creator-outreach-engine:local .

docker volume create creator-outreach-data

docker run -d \
  --name creator-outreach-engine \
  --restart unless-stopped \
  --env-file .env \
  -v creator-outreach-data:/app/data \
  -p 127.0.0.1:3000:3000 \
  creator-outreach-engine:local
```

The image healthcheck follows the configured `PORT`. The image can also load a runtime-mounted `/app/.env`, but passing secrets with the platform or `--env-file` is preferred.

## 2. Configure Nginx and HTTPS

Use the full example in `docs/NGINX.md`. Proxy the whole application, not only `/mcp`.

The public routes include:

- `/health`
- `/ready`
- `/admin`
- `/admin/app.js`
- `/admin/api/*`
- `/mcp`
- `/.well-known/*`
- `/oauth/*`

TLS must terminate on the public HTTPS endpoint before ChatGPT OAuth is configured.

## 3. Verify the fresh deployment before adding a mailbox

Run:

```bash
npm run probe:base
```

Or, from another machine:

```bash
DEPLOY_BASE_URL=https://mail.example.com npm run probe:base
```

The base probe requires the application surface to be healthy but accepts both states from `/ready`:

- HTTP 503: service is running but no mailbox is configured yet.
- HTTP 200: at least one mailbox is already configured.

It also checks that common source, secret, and encrypted-store paths are not publicly readable.

## 4. Add the first mailbox

Open:

```
https://mail.example.com/admin
```

Login username is always `admin`; the password is `MAIL_ADMIN_PASSWORD`.

Add one owned/test mailbox first. Use the Mailbox Manager **Test** action and require both IMAP and SMTP connectivity to pass before creator traffic.

For Alibaba Mail the common defaults are:

- IMAP: `imap.qiye.aliyun.com:993`
- SMTP: `smtp.qiye.aliyun.com:465`
- SMTP security: implicit TLS

For Microsoft 365 SMTP on port 587, use STARTTLS.

## 5. Verify mailbox readiness

After at least one mailbox is configured:

```bash
npm run doctor
npm run probe
```

Expected results:

- `npm run doctor`: every configured account reports ready.
- `GET /health`: HTTP 200.
- `GET /ready`: HTTP 200.
- `npm run probe`: exits successfully.

Do not proceed to real outreach if `doctor` or the full probe fails.

## 6. Verify OAuth/MCP before ChatGPT registration

When OAuth is enabled:

```bash
curl -i https://mail.example.com/.well-known/oauth-protected-resource
curl -i https://mail.example.com/.well-known/oauth-authorization-server
curl -i -X POST https://mail.example.com/mcp \
  -H 'Content-Type: application/json' \
  -d '{}'
```

Expected:

- both discovery endpoints: HTTP 200;
- unauthenticated `/mcp`: HTTP 401;
- the 401 response includes a `WWW-Authenticate` OAuth resource challenge.

## 7. Owned-inbox end-to-end test

Before sending to creators:

1. confirm `list_mailboxes` returns the correct account id and sender address;
2. search the owned mailbox;
3. send one message to an owned recipient;
4. repeat the same request with the same idempotency key and confirm only one delivery;
5. read the received message and thread;
6. reply to the owned message and confirm the sender account remains correct;
7. with multiple mailboxes, intentionally try a mismatched reply and confirm `ACCOUNT_MISMATCH`;
8. confirm the sent message appears in the provider Sent folder.

## Current deployment constraint

Run one Node process / one replica. The default idempotency and OAuth replay state are still process-local. Do not horizontally scale this release until a shared durable backend is implemented and cross-instance replay tests are green.
