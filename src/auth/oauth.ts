import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import express, { type Express, type Request, type Response } from 'express';
import { FailureRateLimiter, applySensitiveHeaders, requestClientKey } from '../http-security.js';

export interface OAuthConfig {
  issuer: string;
  loginPassword: string;
  signingSecret: string;
}

interface RegisteredClient {
  redirectUris: string[];
  name: string;
}

interface PendingAuthorization {
  clientKey: string;
  clientId: string;
  redirectUri: string;
  state?: string;
  scope: string;
  codeChallenge: string;
  expiresAt: number;
}

interface AuthorizationCode {
  clientId: string;
  redirectUri: string;
  scope: string;
  codeChallenge: string;
  expiresAt: number;
}

interface SignedTokenPayload {
  typ: 'access' | 'refresh';
  cid: string;
  aud: string;
  scope: string;
  iat: number;
  exp: number;
  jti?: string;
}

const SUPPORTED_SCOPES = ['mcp:mail', 'offline_access'] as const;
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const AUTHORIZATION_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_AUTHORIZATIONS = 500;
const MAX_PENDING_AUTHORIZATIONS_PER_CLIENT = 10;
const MAX_AUTHORIZATION_CODES = 500;
const MAX_USED_REFRESH_TOKENS = 5000;

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function signPayload(payload: object, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function verifyPayload<T>(token: string, secret: string): T | null {
  const [body, signature, extra] = token.split('.');
  if (!body || !signature || extra) return null;
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  if (!safeEqual(signature, expected)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

function encodeClient(client: RegisteredClient, secret: string): string {
  return `mcp.${signPayload(client, secret)}`;
}

function decodeClient(clientId: string, secret: string): RegisteredClient | null {
  if (!clientId.startsWith('mcp.') || clientId.length > 32_768) return null;
  const client = verifyPayload<RegisteredClient>(clientId.slice(4), secret);
  if (
    !client ||
    !Array.isArray(client.redirectUris) ||
    client.redirectUris.length < 1 ||
    client.redirectUris.length > 10 ||
    client.redirectUris.some((uri) => parseRedirectUri(uri) !== uri) ||
    typeof client.name !== 'string' ||
    client.name.length < 1 ||
    client.name.length > 128
  ) return null;
  return client;
}

function parseRedirectUri(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return null;
    const localhost = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(localhost && url.protocol === 'http:')) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function normalizeScope(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 256) return null;
  const requested = typeof value === 'string' && value.trim()
    ? [...new Set(value.trim().split(/\s+/))]
    : [...SUPPORTED_SCOPES];
  if (requested.some((scope) => !SUPPORTED_SCOPES.includes(scope as (typeof SUPPORTED_SCOPES)[number]))) {
    return null;
  }
  return requested.join(' ');
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char] ?? char);
}

function tokenResponse(config: OAuthConfig, clientId: string, scope: string) {
  const now = Math.floor(Date.now() / 1000);
  const audience = `${config.issuer}/mcp`;
  const accessPayload: SignedTokenPayload = {
    typ: 'access',
    cid: clientId,
    aud: audience,
    scope,
    iat: now,
    exp: now + ACCESS_TOKEN_TTL_SECONDS
  };
  const refreshPayload: SignedTokenPayload = {
    typ: 'refresh',
    cid: clientId,
    aud: audience,
    scope,
    iat: now,
    exp: now + REFRESH_TOKEN_TTL_SECONDS,
    jti: randomBytes(18).toString('base64url')
  };
  return {
    access_token: `oa.${signPayload(accessPayload, config.signingSecret)}`,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: `or.${signPayload(refreshPayload, config.signingSecret)}`,
    scope
  };
}

function verifySignedToken(token: string, prefix: 'oa.' | 'or.', expectedType: 'access' | 'refresh', config: OAuthConfig): SignedTokenPayload | null {
  if (!token.startsWith(prefix)) return null;
  const payload = verifyPayload<SignedTokenPayload>(token.slice(prefix.length), config.signingSecret);
  if (!payload || payload.typ !== expectedType) return null;
  if (payload.aud !== `${config.issuer}/mcp`) return null;
  if (!Number.isInteger(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) return null;
  if (typeof payload.cid !== 'string' || typeof payload.scope !== 'string') return null;
  return payload;
}

export function isOAuthAuthorized(header: string | undefined, config?: OAuthConfig): boolean {
  if (!config || !header?.startsWith('Bearer ')) return false;
  const payload = verifySignedToken(header.slice(7), 'oa.', 'access', config);
  if (!payload) return false;
  return payload.scope.split(/\s+/).includes('mcp:mail');
}

export function oauthChallenge(config: OAuthConfig): string {
  return `Bearer resource_metadata="${config.issuer}/.well-known/oauth-protected-resource", scope="mcp:mail"`;
}

export function registerOAuthRoutes(app: Express, config: OAuthConfig): void {
  const pending = new Map<string, PendingAuthorization>();
  const codes = new Map<string, AuthorizationCode>();
  const usedRefreshTokens = new Map<string, number>();
  const loginLimiter = new FailureRateLimiter(10, 5 * 60 * 1000, 15 * 60 * 1000);
  const tokenLimiter = new FailureRateLimiter(30, 5 * 60 * 1000, 10 * 60 * 1000);
  const urlencoded = express.urlencoded({ extended: false, limit: '32kb' });
  const json = express.json({ limit: '32kb' });

  function prune() {
    const now = Date.now();
    for (const [key, value] of pending) if (value.expiresAt <= now) pending.delete(key);
    for (const [key, value] of codes) if (value.expiresAt <= now) codes.delete(key);
    const nowSeconds = Math.floor(now / 1000);
    for (const [key, expiresAt] of usedRefreshTokens) if (expiresAt <= nowSeconds) usedRefreshTokens.delete(key);
  }

  const protectedResource = {
    resource: `${config.issuer}/mcp`,
    authorization_servers: [config.issuer],
    scopes_supported: [...SUPPORTED_SCOPES],
    bearer_methods_supported: ['header']
  };

  app.use(['/oauth/authorize', '/oauth/token', '/oauth/register'], (_req, res, next) => { applySensitiveHeaders(res); next(); });

  app.get('/.well-known/oauth-protected-resource', (_req, res) => res.json(protectedResource));
  app.get('/.well-known/oauth-protected-resource/mcp', (_req, res) => res.json(protectedResource));

  app.get('/.well-known/oauth-authorization-server', (_req, res) => {
    res.json({
      issuer: config.issuer,
      authorization_endpoint: `${config.issuer}/oauth/authorize`,
      token_endpoint: `${config.issuer}/oauth/token`,
      registration_endpoint: `${config.issuer}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      authorization_response_iss_parameter_supported: true,
      scopes_supported: [...SUPPORTED_SCOPES]
    });
  });

  app.post('/oauth/register', json, (req, res) => {
    const redirectUrisRaw = req.body?.redirect_uris;
    if (!Array.isArray(redirectUrisRaw) || redirectUrisRaw.length < 1 || redirectUrisRaw.length > 10) {
      return res.status(400).json({ error: 'invalid_client_metadata' });
    }
    const redirectUris = redirectUrisRaw.map(parseRedirectUri);
    if (redirectUris.some((uri) => uri === null)) {
      return res.status(400).json({ error: 'invalid_redirect_uri' });
    }
    if (req.body?.token_endpoint_auth_method && req.body.token_endpoint_auth_method !== 'none') {
      return res.status(400).json({ error: 'invalid_client_metadata' });
    }
    const name = typeof req.body?.client_name === 'string' && req.body.client_name.trim()
      ? req.body.client_name.trim().slice(0, 128)
      : 'MCP client';
    const clientId = encodeClient({ redirectUris: redirectUris as string[], name }, config.signingSecret);
    return res.status(201).json({
      client_id: clientId,
      client_name: name,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none'
    });
  });

  app.get('/oauth/authorize', (req, res) => {
    prune();
    const responseType = req.query.response_type;
    const clientId = typeof req.query.client_id === 'string' ? req.query.client_id : '';
    const client = decodeClient(clientId, config.signingSecret);
    const redirectUri = parseRedirectUri(req.query.redirect_uri);
    const codeChallenge = typeof req.query.code_challenge === 'string' ? req.query.code_challenge : '';
    const codeChallengeMethod = req.query.code_challenge_method;
    const scope = normalizeScope(req.query.scope);
    const rawState = req.query.state;
    const state = typeof rawState === 'string' ? rawState : undefined;

    if (
      responseType !== 'code' ||
      !client ||
      !redirectUri ||
      !client.redirectUris.includes(redirectUri) ||
      !scope ||
      (rawState !== undefined && (typeof rawState !== 'string' || rawState.length > 1024))
    ) {
      return res.status(400).send('Invalid OAuth authorization request.');
    }
    if (codeChallengeMethod !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)) {
      return res.status(400).send('PKCE S256 is required.');
    }

    const clientKey = requestClientKey(req);
    let pendingForClient = 0;
    for (const authorization of pending.values()) {
      if (authorization.clientKey === clientKey) pendingForClient += 1;
    }
    if (pendingForClient >= MAX_PENDING_AUTHORIZATIONS_PER_CLIENT) {
      res.setHeader('Retry-After', '60');
      return res.status(429).send('Too many pending authorization requests.');
    }
    if (pending.size >= MAX_PENDING_AUTHORIZATIONS) return res.status(503).send('Authorization service is temporarily busy.');
    const requestId = randomBytes(24).toString('base64url');
    pending.set(requestId, {
      clientKey,
      clientId,
      redirectUri,
      state,
      scope,
      codeChallenge,
      expiresAt: Date.now() + AUTHORIZATION_TTL_MS
    });

    return res.status(200).type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize Creator Outreach Mail</title></head>
<body style="font-family:system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 20px">
<h1>Authorize Creator Outreach Mail</h1>
<p><strong>${escapeHtml(client.name)}</strong> is requesting access to the configured creator-outreach mailboxes.</p>
<p>Requested scope: <code>${escapeHtml(scope)}</code></p>
<p>Redirect destination: <code>${escapeHtml(redirectUri)}</code></p>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="request_id" value="${escapeHtml(requestId)}">
<label>Password<br><input type="password" name="password" required autocomplete="current-password" style="width:100%;padding:10px;margin:8px 0 16px"></label>
<button type="submit" name="decision" value="allow">Authorize</button>
<button type="submit" name="decision" value="deny">Deny</button>
</form></body></html>`);
  });

  app.post('/oauth/authorize', urlencoded, (req, res) => {
    prune();
    const clientKey = requestClientKey(req);
    const loginState = loginLimiter.check(clientKey);
    if (!loginState.allowed) {
      res.setHeader('Retry-After', String(loginState.retryAfterSeconds ?? 900));
      return res.status(429).send('Too many failed authorization attempts.');
    }
    const requestId = typeof req.body?.request_id === 'string' ? req.body.request_id : '';
    const authorization = pending.get(requestId);
    if (!authorization) return res.status(400).send('Authorization request expired or invalid.');

    if (req.body?.decision === 'deny') {
      pending.delete(requestId);
      const redirect = new URL(authorization.redirectUri);
      redirect.searchParams.set('error', 'access_denied');
      if (authorization.state) redirect.searchParams.set('state', authorization.state);
      redirect.searchParams.set('iss', config.issuer);
      return res.redirect(302, redirect.toString());
    }

    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!safeEqual(password, config.loginPassword)) {
      loginLimiter.failure(clientKey);
      return res.status(401).send('Invalid authorization password.');
    }

    loginLimiter.success(clientKey);
    pending.delete(requestId);
    if (codes.size >= MAX_AUTHORIZATION_CODES) return res.status(503).send('Authorization service is temporarily busy.');
    const code = randomBytes(32).toString('base64url');
    codes.set(code, {
      clientId: authorization.clientId,
      redirectUri: authorization.redirectUri,
      scope: authorization.scope,
      codeChallenge: authorization.codeChallenge,
      expiresAt: Date.now() + AUTHORIZATION_TTL_MS
    });

    const redirect = new URL(authorization.redirectUri);
    redirect.searchParams.set('code', code);
    if (authorization.state) redirect.searchParams.set('state', authorization.state);
    redirect.searchParams.set('iss', config.issuer);
    return res.redirect(302, redirect.toString());
  });

  app.post('/oauth/token', urlencoded, (req, res) => {
    prune();
    const clientKey = requestClientKey(req);
    const tokenState = tokenLimiter.check(clientKey);
    if (!tokenState.allowed) {
      res.setHeader('Retry-After', String(tokenState.retryAfterSeconds ?? 600));
      return res.status(429).json({ error: 'temporarily_unavailable' });
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');

    const grantType = req.body?.grant_type;
    const clientId = typeof req.body?.client_id === 'string' ? req.body.client_id : '';
    const client = decodeClient(clientId, config.signingSecret);
    if (!client) {
      tokenLimiter.failure(clientKey);
      return res.status(401).json({ error: 'invalid_client' });
    }

    if (grantType === 'authorization_code') {
      const code = typeof req.body?.code === 'string' ? req.body.code : '';
      const entry = codes.get(code);
      if (!entry) {
        tokenLimiter.failure(clientKey);
        return res.status(400).json({ error: 'invalid_grant' });
      }
      const redirectUri = parseRedirectUri(req.body?.redirect_uri);
      const verifier = typeof req.body?.code_verifier === 'string' ? req.body.code_verifier : '';
      const verifierValid = /^[A-Za-z0-9._~-]{43,128}$/.test(verifier);
      const challenge = verifierValid ? createHash('sha256').update(verifier).digest('base64url') : '';

      if (
        entry.clientId !== clientId ||
        !redirectUri ||
        entry.redirectUri !== redirectUri ||
        !verifierValid ||
        !safeEqual(challenge, entry.codeChallenge)
      ) {
        tokenLimiter.failure(clientKey);
        return res.status(400).json({ error: 'invalid_grant' });
      }
      codes.delete(code);
      tokenLimiter.success(clientKey);
      return res.json(tokenResponse(config, clientId, entry.scope));
    }

    if (grantType === 'refresh_token') {
      const refreshToken = typeof req.body?.refresh_token === 'string' ? req.body.refresh_token : '';
      const payload = verifySignedToken(refreshToken, 'or.', 'refresh', config);
      if (!payload || payload.cid !== clientId || !payload.jti || usedRefreshTokens.has(payload.jti)) {
        tokenLimiter.failure(clientKey);
        return res.status(400).json({ error: 'invalid_grant' });
      }
      if (usedRefreshTokens.size >= MAX_USED_REFRESH_TOKENS) {
        return res.status(503).json({ error: 'temporarily_unavailable' });
      }
      usedRefreshTokens.set(payload.jti, payload.exp);
      tokenLimiter.success(clientKey);
      return res.json(tokenResponse(config, clientId, payload.scope));
    }

    tokenLimiter.failure(clientKey);
    return res.status(400).json({ error: 'unsupported_grant_type' });
  });
}
