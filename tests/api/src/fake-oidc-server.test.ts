import { afterEach, describe, expect, it } from 'vitest';
import { webcrypto } from 'node:crypto';
import { TextEncoder } from 'node:util';
import { importJWK, jwtVerify, type JWK } from 'jose';
import { startFakeOidcServer, type FakeOidcServer } from './fake-oidc-server.js';

/** fake IdP 与 OIDC Core 关键点对齐守卫（discovery/PKCE/nonce/iss/aud/RS256）。 */
describe('fake OIDC server', () => {
  let server: FakeOidcServer | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  async function pkceChallenge(verifier: string): Promise<string> {
    const digest = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return Buffer.from(digest).toString('base64url');
  }

  it('discovery 宣告 S256 + authorize/token 签发可验签 id_token', async () => {
    server = await startFakeOidcServer({ port: 0 });
    const discovery = (await (await fetch(
      `${server.issuer}/.well-known/openid-configuration`,
    )).json()) as {
      issuer: string;
      authorization_endpoint: string;
      token_endpoint: string;
      jwks_uri: string;
      code_challenge_methods_supported: string[];
    };
    expect(discovery.issuer).toBe(server.issuer);
    expect(discovery.code_challenge_methods_supported).toContain('S256');

    const verifier = 'verifier-1234567890';
    const challenge = await pkceChallenge(verifier);
    const authorize = await fetch(
      `${discovery.authorization_endpoint}?client_id=test-oidc-client&redirect_uri=${encodeURIComponent(
        'http://localhost:10001/api/auth/oauth/callback',
      )}&response_type=code&scope=openid%20profile%20email&state=s1&nonce=n1&code_challenge=${challenge}&code_challenge_method=S256`,
      { redirect: 'manual' },
    );
    expect(authorize.status).toBe(302);
    const callback = new URL(authorize.headers.get('location') ?? '');
    expect(callback.searchParams.get('state')).toBe('s1');
    const code = callback.searchParams.get('code') ?? '';

    const token = await fetch(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'http://localhost:10001/api/auth/oauth/callback',
        code_verifier: verifier,
        client_id: 'test-oidc-client',
        client_secret: 'test-oidc-secret',
      }),
    });
    expect(token.status).toBe(200);
    const body = (await token.json()) as { id_token: string };
    expect(body.id_token).toBeTruthy();

    const jwks = (await (await fetch(discovery.jwks_uri)).json()) as { keys: JWK[] };
    const key = await importJWK(jwks.keys[0], 'RS256');
    const verified = await jwtVerify(body.id_token, key, {
      issuer: server.issuer,
      audience: 'test-oidc-client',
    });
    expect(verified.payload).toMatchObject({ sub: 'oidc-user-1', nonce: 'n1' });
  });

  it('PKCE 校验失败拒绝 token；denyNext 返回 access_denied', async () => {
    server = await startFakeOidcServer({ port: 0 });
    const challenge = await pkceChallenge('correct-verifier');
    const authorize = await fetch(
      `${server.issuer}/authorize?client_id=test-oidc-client&redirect_uri=${encodeURIComponent(
        'http://localhost:10001/api/auth/oauth/callback',
      )}&response_type=code&state=s&nonce=n&code_challenge=${challenge}&code_challenge_method=S256`,
      { redirect: 'manual' },
    );
    const code = new URL(authorize.headers.get('location') ?? '').searchParams.get('code') ?? '';
    const bad = await fetch(`${server.issuer}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, code_verifier: 'wrong', client_id: 'test-oidc-client', client_secret: 'test-oidc-secret' }),
    });
    expect(bad.status).toBe(400);

    server.denyNext();
    const denied = await fetch(
      `${server.issuer}/authorize?client_id=test-oidc-client&redirect_uri=${encodeURIComponent(
        'http://localhost:10001/api/auth/oauth/callback',
      )}&state=s2`,
      { redirect: 'manual' },
    );
    expect(denied.headers.get('location')).toContain('error=access_denied');
  });
});
