import { describe, it, expect, afterEach } from 'vitest';
import { config } from '../config/index.js';
import { clientIpFrom } from './client-ip';

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/graphql', { headers });
}

function nodeReq(remoteAddress: string | undefined): unknown {
  return { socket: { remoteAddress } };
}

describe('clientIpFrom (问题 49)', () => {
  const originalTrustProxy = config.trustProxy;

  afterEach(() => {
    config.trustProxy = originalTrustProxy;
  });

  it('uses the socket peer and ignores forged X-Forwarded-For by default', () => {
    config.trustProxy = false;
    const request = makeRequest({ 'x-forwarded-for': '198.51.100.9', 'x-real-ip': '198.51.100.10' });

    expect(clientIpFrom(request, nodeReq('203.0.113.7'))).toBe('203.0.113.7');
  });

  it('rotating X-Forwarded-For cannot rotate the rate-limit identity (no bypass)', () => {
    config.trustProxy = false;
    const peer = nodeReq('203.0.113.7');

    const ips = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      const request = makeRequest({ 'x-forwarded-for': `198.51.100.${i}` });
      ips.add(clientIpFrom(request, peer));
    }

    expect(ips.size).toBe(1);
    expect(ips.has('203.0.113.7')).toBe(true);
  });

  it('absence of forwarding headers does not collapse to a shared unknown bucket', () => {
    config.trustProxy = false;

    const a = clientIpFrom(makeRequest(), nodeReq('203.0.113.7'));
    const b = clientIpFrom(makeRequest(), nodeReq('203.0.113.8'));

    expect(a).toBe('203.0.113.7');
    expect(b).toBe('203.0.113.8');
    expect(a).not.toBe(b);
    expect(a).not.toBe('unknown');
  });

  it('trusts only the last hop of X-Forwarded-For when TRUST_PROXY is enabled', () => {
    config.trustProxy = true;
    const request = makeRequest({ 'x-forwarded-for': '1.2.3.4, 203.0.113.7' });

    expect(clientIpFrom(request, nodeReq('10.0.0.1'))).toBe('203.0.113.7');
  });

  it('falls back to the socket peer when TRUST_PROXY is enabled but no headers present', () => {
    config.trustProxy = true;

    expect(clientIpFrom(makeRequest(), nodeReq('203.0.113.7'))).toBe('203.0.113.7');
  });

  it('returns an empty string (not `unknown`) when no peer can be determined', () => {
    config.trustProxy = false;

    expect(clientIpFrom(makeRequest(), undefined)).toBe('');
  });
});
