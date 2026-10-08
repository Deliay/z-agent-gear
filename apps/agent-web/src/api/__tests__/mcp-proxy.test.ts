import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/api-base', () => ({
  resolveControllerApiBase: vi.fn(),
}));

import { resolveControllerApiBase } from '@/lib/api-base';
import { fetchMcpProxyKeys, createMcpProxyKey, revokeMcpProxyKey } from '../mcp-proxy';

const USER_ID = 'user-1';
const TOKEN = `header.${btoa(JSON.stringify({ userId: USER_ID }))}.signature`;

describe('mcp-proxy', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(resolveControllerApiBase).mockResolvedValue('https://ctrl.zag.fffdan.com');
  });

  it('fetchMcpProxyKeys requests keys from the resolved controller base', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => [] });

    await fetchMcpProxyKeys(TOKEN);

    expect(resolveControllerApiBase).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://ctrl.zag.fffdan.com/api/mcp-proxy-keys',
      expect.objectContaining({ headers: { 'x-user-id': USER_ID } }),
    );
  });

  it('createMcpProxyKey POSTs to the resolved base with name and headers', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });

    await createMcpProxyKey(TOKEN, 'my-key');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://ctrl.zag.fffdan.com/api/mcp-proxy-keys',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': USER_ID },
        body: JSON.stringify({ name: 'my-key' }),
      }),
    );
  });

  it('revokeMcpProxyKey POSTs to the resolved base revoke endpoint', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });

    await revokeMcpProxyKey(TOKEN, 'key-123');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://ctrl.zag.fffdan.com/api/mcp-proxy-keys/key-123/revoke',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('uses whichever base the resolver returns (e.g. local dev)', async () => {
    vi.mocked(resolveControllerApiBase).mockResolvedValue('http://localhost:4001');
    fetchMock.mockResolvedValue({ ok: true, json: async () => [] });

    await fetchMcpProxyKeys(TOKEN);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:4001/api/mcp-proxy-keys',
      expect.anything(),
    );
  });

  it('throws on invalid token without calling fetch', async () => {
    await expect(fetchMcpProxyKeys('invalid-token')).rejects.toThrow('Invalid token');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws when the request is not ok', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({}) });

    await expect(fetchMcpProxyKeys(TOKEN)).rejects.toThrow('Failed to fetch MCP proxy keys');
  });
});
