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

async function expectOneOfStatuses(path, expected, init) {
  const response = await request(path, init);
  if (!response) return null;
  if (!expected.includes(response.status)) {
    failures.push(path + ': expected HTTP ' + expected.join(' or ') + ', got ' + response.status);
  }
  return response;
}

const health = await expectStatus('/health', 200);
if (health) {
  const body = await health.json().catch(() => null);
  if (!body || body.ok !== true || body.service !== 'campx-creator-mail') failures.push('/health: unexpected response body');
}

const allowUnready = process.argv.includes('--allow-unready') || process.env.PROBE_REQUIRE_READY === 'false';
if (allowUnready) {
  await expectOneOfStatuses('/ready', [200, 503]);
} else {
  await expectStatus('/ready', 200);
}
await expectStatus('/favicon.ico', 204);

const adminEnabled = Boolean(process.env.MAIL_ADMIN_PASSWORD && process.env.MAIL_ACCOUNT_STORE_KEY);
await expectStatus('/admin', adminEnabled ? 401 : 404);

if (adminEnabled) {
  const authorization = 'Basic ' + Buffer.from('admin:' + process.env.MAIL_ADMIN_PASSWORD).toString('base64');
  const adminPage = await expectStatus('/admin', 200, { headers: { authorization } });
  if (adminPage) {
    const csp = adminPage.headers.get('content-security-policy') || '';
    if (!csp.includes("script-src 'self'") || csp.includes("script-src 'self' 'unsafe-inline'")) {
      failures.push('/admin: unexpected script CSP');
    }
    const html = await adminPage.text();
    if (!html.includes('<script src="/admin/app.js" defer></script>')) failures.push('/admin: external script tag missing');
    if (/\son(?:click|change)=/i.test(html)) failures.push('/admin: inline event handler found');
  }

  await expectStatus('/admin/app.js', 401);
  const adminScript = await expectStatus('/admin/app.js', 200, { headers: { authorization } });
  if (adminScript) {
    const script = await adminScript.text();
    try {
      new Function(script);
    } catch {
      failures.push('/admin/app.js: JavaScript syntax check failed');
    }
    if (script.includes('innerHTML')) failures.push('/admin/app.js: unsafe innerHTML rendering found');
  }
}

if (process.env.OAUTH_ISSUER) {
  await expectStatus('/.well-known/oauth-protected-resource', 200);
  await expectStatus('/.well-known/oauth-protected-resource/mcp', 200);
  await expectStatus('/.well-known/oauth-authorization-server', 200);
}

for (const sensitivePath of [
  '/.env',
  '/.env.bak',
  '/.git/config',
  '/package.json',
  '/package-lock.json',
  '/src/server.ts',
  '/data/mail-accounts.enc.json'
]) {
  const response = await request(sensitivePath);
  if (response && response.status < 400) {
    failures.push(sensitivePath + ': sensitive deployment path is publicly reachable (HTTP ' + response.status + ')');
  }
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
