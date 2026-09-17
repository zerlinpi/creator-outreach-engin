export function healthPayload() {
  return { ok: true, service: 'campx-creator-mail', version: '0.1.0' } as const;
}
