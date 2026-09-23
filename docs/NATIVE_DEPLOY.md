# Native Node.js deployment

This is the recommended path for a single-server deployment behind same-host Nginx or a control panel such as aaPanel/BT Panel.

The current release must run as **one Node.js process**. Do not enable PM2 cluster mode, multiple workers, or multiple replicas.

## Required runtime

- Node.js 22.12+ (Node 22 LTS recommended)
- npm using the repository lockfile
- Nginx terminating HTTPS
- outbound TCP access to the configured IMAP/SMTP hosts
- a writable project-local `data/` directory when Mailbox Manager is enabled

The repository uses `engine-strict=true`, so `npm ci` will reject unsupported Node.js versions.

## Project directory is mandatory

Run all npm commands from the repository root, the directory containing `package.json`.

The following files use project-relative paths:

- `.env`
- `dist/src/server.js`
- default mailbox store: `./data/mail-accounts.enc.json`

A process manager started from the wrong working directory can therefore miss `.env` or write mailbox data to the wrong location.

Before starting the service:

```bash
cd /absolute/path/to/creator-outreach-engin
npm ci
npm run verify
npm run preflight:native
```

The preflight fails on:

- unsupported Node.js;
- wrong project working directory;
- missing production build;
- invalid production configuration;
- mailbox-store directory permission/write failures.

It reports safe deployment metadata only; secrets and mailbox passwords are not printed.

## Production .env

For a native service behind Nginx on the same host:

```env
NODE_ENV=production
PORT=3000

CONNECTOR_BIND_HOST=127.0.0.1
CONNECTOR_ALLOWED_HOSTS=domail.example.com,127.0.0.1
CONNECTOR_AUTH_TOKEN=<32+ character random secret>
MAIL_MESSAGE_REF_SIGNING_KEY=<separate 32+ character random secret>

MAIL_ADMIN_PASSWORD=<16+ character strong password>
MAIL_ACCOUNT_STORE_KEY=<separate 32+ character random secret>
MAIL_ACCOUNT_STORE_PATH=./data/mail-accounts.enc.json
MAIL_MAX_ACCOUNTS=50
```

If OAuth is enabled:

```env
OAUTH_ISSUER=https://domail.example.com
OAUTH_LOGIN_PASSWORD=<separate 16+ character strong password>
OAUTH_SIGNING_SECRET=<separate 32+ character random secret>
```

Generate secrets separately, for example:

```bash
openssl rand -hex 32
```

## aaPanel / BT Panel

Configure the Node project with:

- **Project directory:** absolute repository root
- **Node version:** Node 22 LTS, at least 22.12
- **Start command:** `npm start`
- **Port:** 3000 (or the same value as `PORT`)
- **Processes/workers:** 1
- **Auto restart:** enabled

Do not configure the panel to run only:

```bash
node dist/src/server.js
```

unless the panel also injects every required environment variable. The supported `npm start` command automatically loads the project-root `.env`.

After configuring the panel, use its application log to confirm:

```text
campx-creator-mail listening on 127.0.0.1:3000 with N mailbox(es)
```

A first Mailbox Manager deployment may legitimately start with `0 mailbox(es)`.

## PM2

If PM2 is used, keep one fork-mode process and set the working directory explicitly:

```bash
pm2 start npm \
  --name creator-outreach-engine \
  --cwd /absolute/path/to/creator-outreach-engin \
  -- start
pm2 save
```

Do not use `-i max`, cluster mode, or multiple PM2 instances for this release.

## systemd

A minimal unit looks like:

```ini
[Unit]
Description=Creator Outreach Engine
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=YOUR_SERVICE_USER
Group=YOUR_SERVICE_GROUP
WorkingDirectory=/absolute/path/to/creator-outreach-engin
ExecStart=/usr/bin/npm start
Restart=on-failure
RestartSec=3
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
```

Confirm the correct npm path first:

```bash
command -v npm
```

Do not copy `/usr/bin/npm` blindly if Node is installed with nvm or another version manager. Use the absolute npm path returned for the service account, or install Node system-wide for the service.

## File ownership and permissions

The service user must be able to read the repository/build and write the mailbox data directory:

```bash
mkdir -p data
chown -R YOUR_SERVICE_USER:YOUR_SERVICE_GROUP data
chmod 700 data
chmod 600 .env
```

Do not change ownership of unrelated server directories just to make the app start.

Run the preflight as the **same OS user that will run Node**:

```bash
sudo -u YOUR_SERVICE_USER -H bash -lc '
  cd /absolute/path/to/creator-outreach-engin &&
  npm run preflight:native
'
```

This catches the common case where root can write `data/` but the actual service user cannot.

## Nginx

Proxy the complete app to loopback:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
    proxy_buffering off;
}
```

Use the sensitive-path deny rule in `docs/NGINX.md` before any static-file location.

## Deployment sequence

From the repository root:

```bash
git checkout main
git pull --ff-only origin main
npm ci
npm run verify
npm run preflight:native
```

Then restart the **single** managed Node process.

Immediately verify locally:

```bash
curl -i http://127.0.0.1:3000/health
curl -i http://127.0.0.1:3000/ready
```

Before adding a mailbox, `/ready` may return 503. Then test the public reverse proxy:

```bash
npm run probe:base
```

After adding/testing at least one mailbox:

```bash
npm run doctor
npm run probe
```

Do not start creator outreach until `doctor` and the full probe both pass.

## Updating an existing native deployment

Do not run two copies during an update. Stop or restart the managed single process around the build/release step according to your process manager.

A conservative update flow is:

```bash
git pull --ff-only origin main
npm ci
npm run verify
npm run preflight:native
# restart the one managed service/process
npm run probe
```

The encrypted mailbox store under `data/` is not regenerated by `npm ci` or `npm run build`. Keep the same `MAIL_ACCOUNT_STORE_KEY`; changing that key makes previously stored mailbox passwords undecryptable.
