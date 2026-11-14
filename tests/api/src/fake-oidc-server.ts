import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { webcrypto } from 'node:crypto';
import { TextEncoder } from 'node:util';
import {
  SignJWT,
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  type JWK,
} from 'jose';

/**
 * 进程内 fake OIDC IdP（计划 D5）。
 *
 * 覆盖 agent-api `openid-client` v6 链路需要的端点：
 * - `GET /.well-known/openid-configuration`：issuer / authorization / token / jwks 元数据
 *   （宣告 `code_challenge_methods_supported: ['S256']`，不降级）；
 * - `GET /jwks`：RS256 公钥 JWK；
 * - `GET /authorize`：校验 state 后 302 回 `redirect_uri?code&state`（模拟用户已授权）；
 *   `denyNext()` 时 302 `?error=access_denied&state`；
 * - `POST /token`：code 换 token，签发含 iss/sub/aud/exp/nonce 的 RS256 id_token；校验 PKCE。
 *
 * 与真实 IdP 对齐点：issuer 精确匹配、aud 含 clientId、nonce 回传、PKCE S256。
 * 只用于测试，不触网、不对生产暴露。
 */
export interface FakeOidcCall {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface FakeOidcClaims {
  sub: string;
  preferred_username?: string;
  name?: string;
  email?: string;
}

export interface FakeOidcServer {
  /** `http://127.0.0.1:<port>`，同时作为 issuer。 */
  issuer: string;
  port: number;
  calls: FakeOidcCall[];
  setClaims(claims: Partial<FakeOidcClaims>): void;
  /** 下一次 authorize 返回 `access_denied`（仅一次）。 */
  denyNext(): void;
  /** 下一次 token 请求返回 400 invalid_grant（仅一次）。 */
  failNextToken(): void;
  /** 已下发的 authorization code 数量。 */
  issuedCodes(): number;
  reset(): void;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { Location: location });
  res.end();
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Buffer.from(digest).toString('base64url');
}

interface AuthCodeRecord {
  nonce: string;
  codeChallenge: string | null;
  redirectUri: string;
  claims: FakeOidcClaims;
}

export async function startFakeOidcServer(options?: {
  port?: number;
  issuer?: string;
  clientId?: string;
  clientSecret?: string;
}): Promise<FakeOidcServer> {
  const port = options?.port ?? Number(process.env.MOCK_OIDC_PORT || 19419);
  let issuer = options?.issuer ?? '';
  const clientId = options?.clientId ?? 'test-oidc-client';
  const clientSecret = options?.clientSecret ?? 'test-oidc-secret';

  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const publicJwk = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(publicJwk, 'sha256');
  const jwk: JWK = { ...publicJwk, kid, alg: 'RS256', use: 'sig' };

  const calls: FakeOidcCall[] = [];
  const codes = new Map<string, AuthCodeRecord>();
  let claims: FakeOidcClaims = {
    sub: 'oidc-user-1',
    preferred_username: 'oidc-test',
    name: 'OIDC Test',
    email: 'oidc-test@example.com',
  };
  let deny = false;
  let failToken = false;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', issuer || `http://127.0.0.1:${port}`);
    const method = req.method ?? 'GET';
    const raw = await readBody(req);
    calls.push({ method, path: `${url.pathname}${url.search}`, headers: req.headers, body: raw });

    if (method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
      json(res, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        userinfo_endpoint: `${issuer}/userinfo`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
        scopes_supported: ['openid', 'profile', 'email'],
        grant_types_supported: ['authorization_code'],
      });
      return;
    }

    if (method === 'GET' && url.pathname === '/jwks') {
      json(res, 200, { keys: [jwk] });
      return;
    }

    if (method === 'GET' && url.pathname === '/authorize') {
      const redirectUri = url.searchParams.get('redirect_uri') ?? '';
      const state = url.searchParams.get('state') ?? '';
      const nonce = url.searchParams.get('nonce') ?? '';
      const codeChallenge = url.searchParams.get('code_challenge');
      if (!redirectUri) {
        json(res, 400, { error: 'invalid_request', error_description: 'missing redirect_uri' });
        return;
      }
      const target = new URL(redirectUri);
      if (state) target.searchParams.set('state', state);
      if (deny) {
        deny = false;
        target.searchParams.set('error', 'access_denied');
        redirect(res, target.toString());
        return;
      }
      const code = `fake-oidc-code-${codes.size + 1}-${Math.random().toString(36).slice(2, 8)}`;
      codes.set(code, {
        nonce,
        codeChallenge,
        redirectUri,
        claims: { ...claims },
      });
      target.searchParams.set('code', code);
      redirect(res, target.toString());
      return;
    }

    if (method === 'POST' && url.pathname === '/token') {
      if (failToken) {
        failToken = false;
        json(res, 400, { error: 'invalid_grant', error_description: 'injected failure' });
        return;
      }
      const form = new URLSearchParams(raw);
      const code = form.get('code') ?? '';
      const record = codes.get(code);
      if (!record) {
        json(res, 400, { error: 'invalid_grant', error_description: 'unknown code' });
        return;
      }
      codes.delete(code);
      if (form.get('redirect_uri') && form.get('redirect_uri') !== record.redirectUri) {
        json(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
        return;
      }
      const verifier = form.get('code_verifier') ?? '';
      if (record.codeChallenge) {
        if (!verifier || (await sha256Base64Url(verifier)) !== record.codeChallenge) {
          json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
          return;
        }
      }

      // client 认证：openid-client 默认 client_secret_basic，兼容 post。
      const basic = req.headers.authorization ?? '';
      let authenticated = false;
      if (basic.startsWith('Basic ')) {
        const decoded = Buffer.from(basic.slice(6), 'base64').toString('utf8');
        const [id, secret] = decoded.split(':');
        authenticated = id === clientId && secret === clientSecret;
      } else {
        authenticated =
          form.get('client_id') === clientId && form.get('client_secret') === clientSecret;
      }
      if (!authenticated) {
        json(res, 401, { error: 'invalid_client' });
        return;
      }

      const idToken = await new SignJWT({
        nonce: record.nonce,
        preferred_username: record.claims.preferred_username,
        name: record.claims.name,
        email: record.claims.email,
      })
        .setProtectedHeader({ alg: 'RS256', kid })
        .setIssuer(issuer)
        .setAudience(clientId)
        .setSubject(record.claims.sub)
        .setIssuedAt()
        .setExpirationTime('10m')
        .sign(privateKey);

      json(res, 200, {
        access_token: `fake-access-${record.claims.sub}`,
        token_type: 'Bearer',
        expires_in: 600,
        id_token: idToken,
        scope: 'openid profile email',
      });
      return;
    }

    json(res, 404, { error: 'not_found' });
  });

  const boundPort = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') resolve(address.port);
      else reject(new Error('fake OIDC server failed to bind'));
    });
  });
  if (!issuer) issuer = `http://127.0.0.1:${boundPort}`;

  return {
    issuer,
    port: boundPort,
    calls,
    setClaims(next) {
      claims = { ...claims, ...next };
    },
    denyNext() {
      deny = true;
    },
    failNextToken() {
      failToken = true;
    },
    issuedCodes() {
      return codes.size;
    },
    reset() {
      calls.length = 0;
      codes.clear();
      deny = false;
      failToken = false;
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
