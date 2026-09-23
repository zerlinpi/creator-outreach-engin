import { createHash, createHmac } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createHttpApp } from '../../src/app.js';

const servers: Array<{ close(cb?: (err?: Error) => void): void }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function fakeAdapters() {
  return {
    imap: {
      async listMailboxes() { return []; },
      async searchEmails() { return []; },
      async getEmail() { throw new Error('not used'); },
      async getThread() { return { messages: [], heuristic: false }; }
    },
    smtp: {
      async send() { throw new Error('not used'); }
    }
  };
}

async function startOAuthApp() {
  const { imap, smtp } = fakeAdapters();
  const oauth = {
    issuer: 'https://domail.campxusainc.com',
    loginPassword: 'oauth-login-password-123',
    signingSecret: 'oauth-signing-secret-1234567890-abcdef'
  };
  const app = createHttpApp({
    authToken: '1234567890abcdef1234567890abcdef',
    mailboxAddress: 'campx@example.com',
    allowedHosts: ['127.0.0.1'],
    imap: imap as never,
    smtp: smtp as never,
    oauth
  });
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, oauth };
}

function signedAccessToken(issuer: string, signingSecret: string, scope: string): string {
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(JSON.stringify({
    typ: 'access',
    cid: 'scope-test-client',
    aud: issuer + '/mcp',
    scope,
    iat: now,
    exp: now + 3600
  }), 'utf8').toString('base64url');
  const signature = createHmac('sha256', signingSecret).update(body).digest('base64url');
  return 'oa.' + body + '.' + signature;
}

function signedRefreshToken(issuer: string, signingSecret: string, clientId: string, scope: string): string {
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(JSON.stringify({
    typ: 'refresh',
    cid: clientId,
    aud: issuer + '/mcp',
    scope,
    iat: now,
    exp: now + 3600,
    jti: 'legacy-refresh-test'
  }), 'utf8').toString('base64url');
  const signature = createHmac('sha256', signingSecret).update(body).digest('base64url');
  return 'or.' + body + '.' + signature;
}

describe('OAuth authorization surface', () => {
  it('enforces the dedicated 32 KiB OAuth registration body limit', async () => {
    const { baseUrl } = await startOAuthApp();
    const response = await fetch(`${baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Oversized registration',
        redirect_uris: ['https://chatgpt.com/aip/callback'],
        token_endpoint_auth_method: 'none',
        padding: 'x'.repeat(40 * 1024)
      })
    });
    expect(response.status).toBe(413);
  });

  it('publishes discovery metadata and advertises the protected resource on 401', async () => {
    const { baseUrl, oauth } = await startOAuthApp();

    const resourceResponse = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
    expect(resourceResponse.status).toBe(200);
    expect(await resourceResponse.json()).toMatchObject({
      resource: `${oauth.issuer}/mcp`,
      authorization_servers: [oauth.issuer],
      scopes_supported: expect.arrayContaining(['mcp:mail', 'offline_access'])
    });

    const metadataResponse = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    expect(metadataResponse.status).toBe(200);
    expect(await metadataResponse.json()).toMatchObject({
      issuer: oauth.issuer,
      authorization_endpoint: `${oauth.issuer}/oauth/authorize`,
      token_endpoint: `${oauth.issuer}/oauth/token`,
      registration_endpoint: `${oauth.issuer}/oauth/register`,
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256']
    });

    const unauthorized = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('www-authenticate')).toContain(
      `resource_metadata="${oauth.issuer}/.well-known/oauth-protected-resource"`
    );
  });

  it('allows the ChatGPT callback only on the OAuth authorization form CSP', async () => {
    const { baseUrl } = await startOAuthApp();
    const redirectUri = 'https://chatgpt.com/connector_platform_oauth_redirect';
    const registration = await fetch(`${baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'ChatGPT',
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: 'none'
      })
    });
    expect(registration.status).toBe(201);
    const registrationCsp = registration.headers.get('content-security-policy') ?? '';
    expect(registrationCsp).toContain("form-action 'self';");
    expect(registrationCsp).not.toContain('https://chatgpt.com');

    const registered = await registration.json() as { client_id: string };
    const challenge = createHash('sha256').update('A'.repeat(64)).digest('base64url');
    const authorizeUrl = new URL(`${baseUrl}/oauth/authorize`);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', registered.client_id);
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    authorizeUrl.searchParams.set('scope', 'mcp:mail');
    authorizeUrl.searchParams.set('code_challenge', challenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');

    const authorize = await fetch(authorizeUrl);
    expect(authorize.status).toBe(200);
    const authorizeCsp = authorize.headers.get('content-security-policy') ?? '';
    expect(authorizeCsp).toContain("form-action 'self' https://chatgpt.com;");
  });

  it('rejects a valid access token that lacks the mcp:mail scope', async () => {
    const { baseUrl, oauth } = await startOAuthApp();
    const token = signedAccessToken(oauth.issuer, oauth.signingSecret, 'offline_access');
    const response = await fetch(baseUrl + '/mcp', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: '{}'
    });
    expect(response.status).toBe(401);
  });

  it('rejects legacy refresh tokens whose scope did not include offline_access', async () => {
    const { baseUrl, oauth } = await startOAuthApp();
    const redirectUri = 'https://chatgpt.com/aip/callback';
    const registration = await fetch(`${baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Legacy refresh test', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' })
    });
    const registered = await registration.json() as { client_id: string };
    const legacy = signedRefreshToken(oauth.issuer, oauth.signingSecret, registered.client_id, 'mcp:mail');

    const response = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: registered.client_id,
        refresh_token: legacy
      })
    });
    expect(response.status).toBe(400);
  });

  it('rejects authorization requests that omit the required mcp:mail scope', async () => {
    const { baseUrl } = await startOAuthApp();
    const redirectUri = 'https://chatgpt.com/aip/callback';
    const registration = await fetch(`${baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Scope test', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' })
    });
    const registered = await registration.json() as { client_id: string };
    const challenge = createHash('sha256').update('A'.repeat(64)).digest('base64url');
    const authorizeUrl = new URL(`${baseUrl}/oauth/authorize`);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', registered.client_id);
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    authorizeUrl.searchParams.set('scope', 'offline_access');
    authorizeUrl.searchParams.set('code_challenge', challenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    const response = await fetch(authorizeUrl);
    expect(response.status).toBe(400);
  });

  it('bounds pending authorization requests per client IP', async () => {
    const { baseUrl } = await startOAuthApp();
    const redirectUri = 'https://chatgpt.com/aip/callback';
    const registration = await fetch(`${baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Rate limit test', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' })
    });
    const registered = await registration.json() as { client_id: string };
    const challenge = createHash('sha256').update('A'.repeat(64)).digest('base64url');

    const authorizeUrl = new URL(`${baseUrl}/oauth/authorize`);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', registered.client_id);
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    authorizeUrl.searchParams.set('scope', 'mcp:mail');
    authorizeUrl.searchParams.set('code_challenge', challenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');

    for (let index = 0; index < 10; index += 1) {
      const response = await fetch(authorizeUrl, { headers: { 'x-forwarded-for': '203.0.113.20' } });
      expect(response.status).toBe(200);
    }
    const blocked = await fetch(authorizeUrl, { headers: { 'x-forwarded-for': '203.0.113.20' } });
    expect(blocked.status).toBe(429);

    const otherClient = await fetch(authorizeUrl, { headers: { 'x-forwarded-for': '203.0.113.21' } });
    expect(otherClient.status).toBe(200);
  });

  it('completes DCR, PKCE authorization, token exchange, refresh, and MCP tool access', async () => {
    const { baseUrl } = await startOAuthApp();
    const redirectUri = 'https://chatgpt.com/aip/callback';

    const registration = await fetch(`${baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'ChatGPT',
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: 'none'
      })
    });
    expect(registration.status).toBe(201);
    const registered = await registration.json() as { client_id: string };
    expect(registered.client_id).toMatch(/^mcp\./);

    const onlineVerifier = 'B'.repeat(64);
    const onlineChallenge = createHash('sha256').update(onlineVerifier).digest('base64url');
    const onlineAuthorizeUrl = new URL(`${baseUrl}/oauth/authorize`);
    onlineAuthorizeUrl.searchParams.set('response_type', 'code');
    onlineAuthorizeUrl.searchParams.set('client_id', registered.client_id);
    onlineAuthorizeUrl.searchParams.set('redirect_uri', redirectUri);
    onlineAuthorizeUrl.searchParams.set('scope', 'mcp:mail');
    onlineAuthorizeUrl.searchParams.set('code_challenge', onlineChallenge);
    onlineAuthorizeUrl.searchParams.set('code_challenge_method', 'S256');

    const onlineAuthorize = await fetch(onlineAuthorizeUrl);
    expect(onlineAuthorize.status).toBe(200);
    const onlineHtml = await onlineAuthorize.text();
    expect(onlineHtml).toContain('Redirect destination:');
    expect(onlineHtml).toContain(redirectUri);
    const onlineRequestId = /name="request_id" value="([^"]+)"/.exec(onlineHtml)?.[1];
    expect(onlineRequestId).toBeTruthy();

    const onlineConsent = await fetch(`${baseUrl}/oauth/authorize`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        request_id: onlineRequestId!,
        password: 'oauth-login-password-123',
        decision: 'allow'
      })
    });
    const onlineCallback = new URL(onlineConsent.headers.get('location')!);
    const onlineCode = onlineCallback.searchParams.get('code');
    expect(onlineCode).toBeTruthy();

    const onlineToken = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: registered.client_id,
        redirect_uri: redirectUri,
        code: onlineCode!,
        code_verifier: onlineVerifier
      })
    });
    expect(onlineToken.status).toBe(200);
    const onlineTokenBody = await onlineToken.json() as Record<string, unknown>;
    expect(onlineTokenBody.access_token).toEqual(expect.stringMatching(/^oa\./));
    expect(onlineTokenBody.scope).toBe('mcp:mail');
    expect(onlineTokenBody).not.toHaveProperty('refresh_token');

    const compatVerifier = 'C'.repeat(63) + '=';
    const compatChallenge = createHash('sha256').update(compatVerifier).digest('base64url');
    const compatAuthorizeUrl = new URL(`${baseUrl}/oauth/authorize`);
    compatAuthorizeUrl.searchParams.set('response_type', 'code');
    compatAuthorizeUrl.searchParams.set('client_id', registered.client_id);
    compatAuthorizeUrl.searchParams.set('redirect_uri', redirectUri);
    compatAuthorizeUrl.searchParams.set('scope', 'mcp:mail');
    compatAuthorizeUrl.searchParams.set('code_challenge', compatChallenge);
    compatAuthorizeUrl.searchParams.set('code_challenge_method', 'S256');

    const compatAuthorize = await fetch(compatAuthorizeUrl);
    expect(compatAuthorize.status).toBe(200);
    const compatHtml = await compatAuthorize.text();
    const compatRequestId = /name="request_id" value="([^"]+)"/.exec(compatHtml)?.[1];
    expect(compatRequestId).toBeTruthy();

    const compatConsent = await fetch(`${baseUrl}/oauth/authorize`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        request_id: compatRequestId!,
        password: 'oauth-login-password-123',
        decision: 'allow'
      })
    });
    expect(compatConsent.status).toBe(302);
    const compatCode = new URL(compatConsent.headers.get('location')!).searchParams.get('code');
    expect(compatCode).toBeTruthy();

    const compatToken = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: registered.client_id,
        redirect_uri: redirectUri,
        code: compatCode!,
        code_verifier: compatVerifier
      })
    });
    expect(compatToken.status).toBe(200);

    const verifier = 'A'.repeat(64);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const authorizeUrl = new URL(`${baseUrl}/oauth/authorize`);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', registered.client_id);
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    authorizeUrl.searchParams.set('scope', 'mcp:mail offline_access');
    authorizeUrl.searchParams.set('state', 'test-state');
    authorizeUrl.searchParams.set('code_challenge', challenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');

    const authorize = await fetch(authorizeUrl);
    expect(authorize.status).toBe(200);
    const html = await authorize.text();
    const requestId = /name="request_id" value="([^"]+)"/.exec(html)?.[1];
    expect(requestId).toBeTruthy();

    const consent = await fetch(`${baseUrl}/oauth/authorize`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        request_id: requestId!,
        password: 'oauth-login-password-123',
        decision: 'allow'
      })
    });
    expect(consent.status).toBe(302);
    const callback = new URL(consent.headers.get('location')!);
    expect(callback.origin + callback.pathname).toBe(redirectUri);
    expect(callback.searchParams.get('state')).toBe('test-state');
    expect(callback.searchParams.get('iss')).toBe('https://domail.campxusainc.com');
    const code = callback.searchParams.get('code');
    expect(code).toBeTruthy();

    const malformedVerifier = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: registered.client_id,
        redirect_uri: redirectUri,
        code: code!,
        code_verifier: 'short'
      })
    });
    expect(malformedVerifier.status).toBe(400);

    const token = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: registered.client_id,
        redirect_uri: redirectUri,
        code: code!,
        code_verifier: verifier
      })
    });
    expect(token.status).toBe(200);
    const tokenBody = await token.json() as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      scope: string;
    };
    expect(tokenBody.access_token).toMatch(/^oa\./);
    expect(tokenBody.refresh_token).toMatch(/^or\./);
    expect(tokenBody.access_token.length).toBeLessThan(2048);
    expect(tokenBody.refresh_token.length).toBeLessThan(2048);
    expect(tokenBody.expires_in).toBe(3600);

    const replay = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: registered.client_id,
        redirect_uri: redirectUri,
        code: code!,
        code_verifier: verifier
      })
    });
    expect(replay.status).toBe(400);

    const refreshed = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: registered.client_id,
        refresh_token: tokenBody.refresh_token
      })
    });
    expect(refreshed.status).toBe(200);
    const refreshedBody = await refreshed.json() as { access_token: string; refresh_token: string; token_type: string };
    expect(refreshedBody).toMatchObject({
      access_token: expect.stringMatching(/^oa\./),
      refresh_token: expect.stringMatching(/^or\./),
      token_type: 'Bearer'
    });

    const refreshReplay = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: registered.client_id,
        refresh_token: tokenBody.refresh_token
      })
    });
    expect(refreshReplay.status).toBe(400);

    const client = new Client(
      { name: 'oauth-connector-test', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } }
    );
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${tokenBody.access_token}` } }
    });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        'get_email',
        'get_thread',
        'list_mailboxes',
        'reply_email',
        'search_emails',
        'send_email',
        'send_email_batch'
      ]);
    } finally {
      await transport.terminateSession().catch(() => undefined);
      await client.close();
    }
  });
});
