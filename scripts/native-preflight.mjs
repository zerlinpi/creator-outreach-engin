import { access, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const failures = [];
const warnings = [];
const root = process.cwd();

function fail(message) { failures.push(message); }
function warn(message) { warnings.push(message); }

function supportedNode(version) {
  const match = /^v(\d+)\.(\d+)\./.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return (major === 22 && minor >= 12) || major === 24 || major >= 26;
}

if (!supportedNode(process.version)) {
  fail('Unsupported Node.js version ' + process.version + '. Use Node 22.12+, Node 24, or Node 26+.');
}

let packageJson;
try {
  packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  if (packageJson.name !== 'creator-outreach-engin') {
    fail('Current working directory is not the creator-outreach-engin project root.');
  }
} catch {
  fail('package.json could not be read from the current working directory.');
}

try {
  await access(resolve(root, 'dist/src/server.js'), constants.R_OK);
} catch {
  fail('dist/src/server.js is missing. Run npm ci && npm run verify before deployment.');
}

let config;
if (!failures.length) {
  try {
    const module = await import('../dist/src/config.js');
    config = module.loadConfig(process.env);
  } catch (error) {
    fail('Production configuration is invalid: ' + (error instanceof Error ? error.message : 'unknown configuration error'));
  }
}

if (config) {
  if (process.env.NODE_ENV !== 'production') fail('NODE_ENV must be production for native deployment.');
  if (config.bindHost !== '127.0.0.1') {
    warn('CONNECTOR_BIND_HOST is not 127.0.0.1. For same-host Nginx/native deployment, loopback binding is recommended.');
  }

  const storePath = config.mailAdmin?.storePath;
  if (storePath) {
    const absoluteStorePath = resolve(root, storePath);
    const directory = dirname(absoluteStorePath);
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const probePath = resolve(directory, '.native-write-probe-' + process.pid);
      await writeFile(probePath, 'ok', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await unlink(probePath);
    } catch (error) {
      fail('Mailbox data directory is not writable: ' + directory + ' (' + (error instanceof Error ? error.message : 'write failed') + ')');
    }
  }

  const summary = {
    ok: failures.length === 0,
    node: process.version,
    cwd: root,
    nodeEnv: process.env.NODE_ENV ?? null,
    bindHost: config.bindHost ?? null,
    port: config.port,
    allowedHosts: config.allowedHosts ?? [],
    mailboxManagerEnabled: Boolean(config.mailAdmin),
    environmentMailboxCount: Object.keys(config.accounts ?? {}).length,
    oauthEnabled: Boolean(config.oauth),
    storePath: config.mailAdmin?.storePath ? resolve(root, config.mailAdmin.storePath) : null,
    warnings,
    failures
  };
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.error(JSON.stringify({ ok: false, node: process.version, cwd: root, warnings, failures }, null, 2));
}

if (failures.length) process.exitCode = 1;
