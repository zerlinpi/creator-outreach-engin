const base = (process.env.DEPLOY_BASE_URL || process.env.OAUTH_ISSUER || `http://127.0.0.1:${process.env.PORT || '3000'}`).replace(/\/$/, '');
const failures = [];

async function request(path, init) {
  try {
    return await fetch(base + path, { redirect: 'manual', ...init });
  } catch (error) {
    failures.push(path + ': request failed (' + (error instanceof Error ? error.message : 'unknown error') + ')');
    return null;
  }
}

async function expectStatus(path, expected, init) {
  const response = await request(path, init);
  if (!response) return null;
  if (response.status !== expected) failures.push(path + ': expected HTTP ' + expected + ', got ' + response.status);
  return response;
}

const health = await expectStatus('/health', 200);
if (health) {
  const body = await health.json().catch(() => null);
  if (!body || body.ok !== true || body.service !== 'campx-creator-mail') failures.push('/health: unexpected response body');
}

const requireReady = process.env.PROBE_REQUIRE_READY !== 'false';
await expectStatus('/ready', requireReady ? 200 : 503);
await expectStatus('/favicon.ico', 204);

const adminEnabled = Boolean(process.env.MAIL_ADMIN_PASSWORD && process.env.MAIL_ACCOUNT_STORE_KEY);
await expectStatus('/admin', adminEnabled ? 401 : 404);

if (process.env.OAUTH_ISSUER) {
  await expectStatus('/.well-known/oauth-protected-resource', 200);
  await expectStatus('/.well-known/oauth-protected-resource/mcp', 200);
  await expectStatus('/.well-known/oauth-authorization-server', 200);
}

const mcp = await expectStatus('/mcp', 401, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}'
});
if (mcp && process.env.OAUTH_ISSUER) {
  const challenge = mcp.headers.get('www-authenticate') || '';
  if (!challenge.includes('/.well-known/oauth-protected-resource')) failures.push('/mcp: missing OAuth resource metadata challenge');
}

if (failures.length) {
  console.error(JSON.stringify({ ok: false, base, failures }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ ok: true, base }, null, 2));
}
