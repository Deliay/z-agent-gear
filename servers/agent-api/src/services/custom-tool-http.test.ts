import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    fetch: vi.fn(),
    Agent: class MockAgent {
      options: unknown;
      constructor(options: unknown) {
        this.options = options;
      }
    },
  };
});
vi.mock('./valut-service.js', () => ({
  valutService: { resolveManualValueByKey: vi.fn() },
}));

import { fetch as undiciFetch } from 'undici';
import { valutService } from './valut-service.js';
import {
  execute,
  insecureAgent,
  CustomToolHttpError,
  HTTP_RESPONSE_MAX_BYTES,
} from './custom-tool-http.js';
import type { CustomToolMcpEntry } from './custom-tool-service.js';
import type { Fragment, RenderContext } from './fragment-render.js';

const ctx: RenderContext = {
  userId: 'u1',
  tenantId: 't1',
  workspaceId: 'ws1',
  params: { city: '北京 上海', token: 'should-not-be-used' },
};

function f(type: Fragment['type'], value: string, format: Fragment['format'] = 'Generic'): Fragment {
  return { type, value, format };
}

function tool(overrides: Partial<NonNullable<CustomToolMcpEntry['http']>> = {}): CustomToolMcpEntry {
  return {
    id: 'tool-1',
    name: 'h',
    description: null,
    type: 'http',
    args: [
      { key: 'city', name: 'city', description: null },
      { key: 'token', name: 'token', description: null },
    ],
    prompt: null,
    http: {
      method: 'POST',
      endpoint: [f('Plain', 'https://api.example.com/v1/items')],
      insecure: false,
      bodyType: 'json',
      body: [f('Plain', '{"city":'), f('Parameter', 'city', 'Json'), f('Plain', '}')],
      form: null,
      headers: [{ key: 'X-City', value: [f('Parameter', 'city')] }],
      queries: [{ key: 'q', value: [f('Parameter', 'city', 'Uri')] }],
      ...overrides,
    },
    workspaceId: 'ws1',
    createdBy: 'u1',
  };
}

function response(opts: {
  status?: number;
  contentType?: string | null;
  body?: string;
  bytes?: number;
}) {
  const buffer = opts.bytes
    ? Buffer.alloc(opts.bytes, 0x61)
    : Buffer.from(opts.body ?? '', 'utf8');
  return {
    status: opts.status ?? 200,
    headers: { get: () => opts.contentType ?? 'text/plain' },
    arrayBuffer: async () =>
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(valutService.resolveManualValueByKey).mockResolvedValue('secret-value');
  vi.mocked(undiciFetch).mockResolvedValue(response({ body: 'ok' }) as never);
});

describe('custom-tool-http（T-CTH1~4）', () => {
  it('T-CTH1：endpoint/queries/headers/body 渲染正确，query 不二次编码', async () => {
    await execute(tool(), { city: '北京 上海', token: 'x' }, ctx);
    const [url, init] = vi.mocked(undiciFetch).mock.calls[0] as [URL, Record<string, unknown>];
    expect(url.toString()).toBe(
      `https://api.example.com/v1/items?q=${encodeURIComponent('北京 上海')}`,
    );
    expect(url.toString()).not.toContain('%2520');

    const headers = init.headers as unknown as { get: (name: string) => string | null };
    expect(headers.get('x-city')).toBe(encodeURIComponent('北京 上海'));
    expect(headers.get('content-type')).toBe('application/json');

    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"city":"北京 上海"}');
    expect(init.dispatcher).toBeUndefined();
  });

  it('T-CTH1：托管 content-type 覆盖用户同名 header', async () => {
    await execute(
      tool({ headers: [{ key: 'Content-Type', value: [f('Plain', 'text/csv')] }] }),
      { city: 'x', token: 'y' },
      ctx,
    );
    const init = vi.mocked(undiciFetch).mock.calls[0][1] as {
      headers: { get: (name: string) => string | null };
    };
    expect(init.headers.get('content-type')).toBe('application/json');
  });

  it('T-CTH1：endpoint 非 http(s) / json 非法 → 白名单错误', async () => {
    await expect(
      execute(tool({ endpoint: [f('Plain', 'ftp://x')] }), { city: 'x', token: 'y' }, ctx),
    ).rejects.toThrow('invalid endpoint');
    await expect(
      execute(tool({ body: [f('Plain', 'not-json')] }), { city: 'x', token: 'y' }, ctx),
    ).rejects.toThrow('rendered body is not valid json');
  });

  it('T-CTH2：insecure=true 使用独立 dispatcher', async () => {
    await execute(tool({ insecure: true }), { city: 'x', token: 'y' }, ctx);
    const init = vi.mocked(undiciFetch).mock.calls[0][1] as { dispatcher?: unknown };
    expect(init.dispatcher).toBe(insecureAgent);
  });

  it('T-CTH3：不可达 / 超时 / TLS 错误归类文案', async () => {
    vi.mocked(undiciFetch).mockRejectedValueOnce(Object.assign(new Error('boom'), { name: 'AbortError' }));
    await expect(execute(tool(), { city: 'x', token: 'y' }, ctx)).rejects.toThrow('request timeout');

    vi.mocked(undiciFetch).mockRejectedValueOnce(
      Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }),
    );
    await expect(execute(tool(), { city: 'x', token: 'y' }, ctx)).rejects.toThrow('tls verification failed');

    vi.mocked(undiciFetch).mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(execute(tool(), { city: 'x', token: 'y' }, ctx)).rejects.toThrow('request failed');
  });

  it('T-CTH3：响应 >256KB 截断并标注 truncated', async () => {
    vi.mocked(undiciFetch).mockResolvedValue(
      response({ bytes: HTTP_RESPONSE_MAX_BYTES + 10, contentType: 'text/plain' }) as never,
    );
    const result = await execute(tool(), { city: 'x', token: 'y' }, ctx);
    expect(result.truncated).toBe(true);
    expect(result.bodyText.length).toBe(HTTP_RESPONSE_MAX_BYTES);
    expect(result.contentType).toBe('text/plain');
  });

  it('T-CTH4：错误对象不携带渲染值 / 密钥（日志红线前置：只抛归类文案）', async () => {
    vi.mocked(valutService.resolveManualValueByKey).mockResolvedValue('PLAINTEXT-SECRET');
    vi.mocked(undiciFetch).mockRejectedValue(
      new Error('failed https://api.example.com/?token=PLAINTEXT-SECRET'),
    );
    try {
      await execute(
        tool({ headers: [{ key: 'Authorization', value: [f('Valut', 'TOKEN')] }] }),
        { city: 'x' },
        ctx,
      );
      throw new Error('unreachable');
    } catch (err) {
      expect(err).toBeInstanceOf(CustomToolHttpError);
      expect((err as Error).message).toBe('request failed');
      expect((err as Error).message).not.toContain('PLAINTEXT-SECRET');
    }
  });
});
