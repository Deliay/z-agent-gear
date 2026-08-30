import { describe, it, expect, vi, afterEach } from 'vitest';
import { McpRelay, type McpRelayResult } from './relay.js';

function createRelay() {
  const emitted: Array<{ requestId: string; sessionId: string; serverName: string; token: string; body: unknown }> = [];
  const relay = new McpRelay((payload) => emitted.push(payload));
  return { relay, emitted };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('McpRelay', () => {
  it('T-C6 resolves a pending request by requestId on mcp:response', async () => {
    const { relay, emitted } = createRelay();
    relay.registerSession('sess-1', { token: 'tok-1', serverNames: ['github-mcp'] });

    const promise = relay.forward('sess-1', 'github-mcp', { method: 'tools/list' });
    expect(emitted).toHaveLength(1);
    expect(emitted[0].requestId).toMatch(/^mcpreq_/);
    expect(emitted[0]).toMatchObject({
      sessionId: 'sess-1',
      serverName: 'github-mcp',
      token: 'tok-1',
      body: { method: 'tools/list' },
    });

    relay.handleMcpResponse(emitted[0].requestId, 200, { result: [] });
    await expect(promise).resolves.toEqual({ status: 200, body: { result: [] } });
  });

  it('T-C7 times out after 60s with 504 and cleans up pending', async () => {
    vi.useFakeTimers();
    const { relay, emitted } = createRelay();
    relay.registerSession('sess-1', { token: 'tok-1', serverNames: ['github-mcp'] });

    const first = relay.forward('sess-1', 'github-mcp', { method: 'tools/list' });
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(first).resolves.toEqual(expect.objectContaining({ status: 504 }));

    const second = relay.forward('sess-1', 'github-mcp', { method: 'tools/call' });
    emitted[1] && relay.handleMcpResponse(emitted[1].requestId, 200, { ok: true });
    await expect(second).resolves.toEqual({ status: 200, body: { ok: true } });
  });

  it('T-C8 fails all pending immediately with 503 on disconnect', async () => {
    const { relay, emitted } = createRelay();
    relay.registerSession('sess-1', { token: 'tok-1', serverNames: ['a-mcp'] });
    const promises = [
      relay.forward('sess-1', 'a-mcp', { id: 1 }),
      relay.forward('sess-1', 'a-mcp', { id: 2 }),
    ];
    expect(emitted).toHaveLength(2);

    relay.handleDisconnect();
    const results = await Promise.all(promises);
    expect(results).toEqual([
      expect.objectContaining({ status: 503 }),
      expect.objectContaining({ status: 503 }),
    ]);
  });

  it('T-C9 unregistering a session fails its pending with 410, other sessions unaffected', async () => {
    const { relay, emitted } = createRelay();
    relay.registerSession('sess-1', { token: 'tok-1', serverNames: ['a-mcp'] });
    relay.registerSession('sess-2', { token: 'tok-2', serverNames: ['b-mcp'] });

    const sess1 = relay.forward('sess-1', 'a-mcp', { id: 1 });
    const sess2 = relay.forward('sess-2', 'b-mcp', { id: 2 });

    relay.unregisterSession('sess-1');
    await expect(sess1).resolves.toEqual(expect.objectContaining({ status: 410 }));
    expect(relay.hasSession('sess-1')).toBe(false);
    expect(relay.hasSession('sess-2')).toBe(true);

    emitted[1] && relay.handleMcpResponse(emitted[1].requestId, 200, { ok: true });
    await expect(sess2).resolves.toEqual({ status: 200, body: { ok: true } });
  });

  it('T-C10 ignores mcp:response for an unknown requestId', async () => {
    const { relay } = createRelay();
    expect(() => relay.handleMcpResponse('mcpreq_unknown', 200, {})).not.toThrow();
  });

  it('forward returns 404 for an unregistered session', async () => {
    const { relay } = createRelay();
    const result: McpRelayResult = await relay.forward('missing', 'a-mcp', {});
    expect(result.status).toBe(404);
  });
});