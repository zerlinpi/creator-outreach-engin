import { isIP } from 'node:net';

export function isHostnameOrIpv4(value: string): boolean {
  const host = value.trim();
  if (!host || host.length > 253) return false;
  if (isIP(host) === 4) return true;
  if (/^\d+(?:\.\d+){3}$/.test(host)) return false;
  if (host.includes(':')) return false;

  const labels = host.split('.');
  return labels.every((label) =>
    label.length >= 1 &&
    label.length <= 63 &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label)
  );
}
