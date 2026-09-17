import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createHttpApp } from '../../src/app.js';

const servers: Array<{ close(cb?: (err?: Error) => void): void }> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('health endpoint', () => {
  it('returns only non-sensitive process health data', async () => {
    const app = createHttpApp({
      authToken: '1234567890abcdef',
      mailboxAddress: 'campx@example.com',
      imap: {} as never,
      smtp: {} as never
    });
    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: 'campx-creator-mail' });
  });
});
