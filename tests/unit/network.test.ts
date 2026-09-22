import { describe, expect, it } from 'vitest';
import { isHostnameOrIpv4 } from '../../src/network.js';

describe('network host validation', () => {
  it('accepts normal hostnames, localhost, punycode, and IPv4', () => {
    expect(isHostnameOrIpv4('imap.qiye.aliyun.com')).toBe(true);
    expect(isHostnameOrIpv4('localhost')).toBe(true);
    expect(isHostnameOrIpv4('xn--example-ova.com')).toBe(true);
    expect(isHostnameOrIpv4('127.0.0.1')).toBe(true);
  });

  it('rejects schemes, ports, malformed labels, wildcards, and IPv6', () => {
    for (const value of [
      'https://imap.example.com',
      'imap.example.com:993',
      '*.example.com',
      '.example.com',
      'example.com.',
      'example..com',
      '-mail.example.com',
      'mail-.example.com',
      'bad host.example.com',
      '999.999.999.999',
      '::1'
    ]) {
      expect(isHostnameOrIpv4(value)).toBe(false);
    }
  });
});
