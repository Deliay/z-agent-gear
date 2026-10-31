import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'child_process';
import { createStdioDispatcher } from '../../src/commands/mcp-proxy.js';

function createFakeChild(): ChildProcess & EventEmitter {
  const proc = new EventEmitter() as ChildProcess & EventEmitter;
  Object.defineProperty(proc, 'stdin', { value: new PassThrough(), writable: true });
  Object.defineProperty(proc, 'stdout', { value: new PassThrough(), writable: true });
  Object.defineProperty(proc, 'stderr', { value: new PassThrough(), writable: true });
  return proc;
}

function stdinWrites(child: ChildProcess): string[] {
  const chunks: string[] = [];
  (child.stdin as PassThrough).on('data', (d: Buffer) => chunks.push(d.toString()));
  return chunks;
}

describe('createStdioDispatcher', () => {
  let child: ChildProcess & EventEmitter;

  beforeEach(() => {
    child = createFakeChild();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should forward notifications fire-and-forget without waiting for a response', async () => {
    const writes = stdinWrites(child);
    const dispatcher = createStdioDispatcher(child);

    const start = Date.now();
    const result = await dispatcher.forward({ jsonrpc: '2.0', method: 'notifications/initialized' });

    // must resolve immediately — the MCP server never responds to notifications
    expect(Date.now() - start).toBeLessThan(1000);
    expect(result).toBeNull();
    expect(writes.join('')).toContain('"method":"notifications/initialized"');
  });

  it('should resolve a request when the child responds with the matching id', async () => {
    const dispatcher = createStdioDispatcher(child);

    const promise = dispatcher.forward({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    (child.stdout as PassThrough).write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }) + '\n');

    await expect(promise).resolves.toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } });
  });

  it('should reassemble a JSON response split across multiple chunks', async () => {
    const dispatcher = createStdioDispatcher(child);

    const promise = dispatcher.forward({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const full = JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'probe_tool' }] } }) + '\n';
    // TCP/stdio gives no message boundary guarantees: split the response
    (child.stdout as PassThrough).write(full.slice(0, 10));
    (child.stdout as PassThrough).write(full.slice(10, 40));
    (child.stdout as PassThrough).write(full.slice(40));

    await expect(promise).resolves.toEqual({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'probe_tool' }] } });
  });

  it('should match concurrent responses to their requests by id, even out of order', async () => {
    const dispatcher = createStdioDispatcher(child);

    const p1 = dispatcher.forward({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const p2 = dispatcher.forward({ jsonrpc: '2.0', id: 2, method: 'tools/call' });

    // second request answers first, and both arrive in one chunk
    (child.stdout as PassThrough).write(
      JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [] } }) + '\n' +
      JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } }) + '\n',
    );

    await expect(p1).resolves.toEqual({ jsonrpc: '2.0', id: 1, result: { tools: [] } });
    await expect(p2).resolves.toEqual({ jsonrpc: '2.0', id: 2, result: { content: [] } });
  });

  it('should reject when the request times out', async () => {
    vi.useFakeTimers();
    try {
      const dispatcher = createStdioDispatcher(child);

      const promise = dispatcher.forward({ jsonrpc: '2.0', id: 9, method: 'tools/list' });
      const assertion = expect(promise).rejects.toThrow('Request timeout waiting for tools/list');
      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('should reject all pending requests when the child exits', async () => {
    const dispatcher = createStdioDispatcher(child);

    const promise = dispatcher.forward({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    child.emit('exit', 1);

    await expect(promise).rejects.toThrow('MCP command exited with code 1');
  });

  it('should ignore non-JSON lines instead of failing the pending request', async () => {
    const dispatcher = createStdioDispatcher(child);

    const promise = dispatcher.forward({ jsonrpc: '2.0', id: 4, method: 'initialize' });
    (child.stdout as PassThrough).write('[some log line that is not json]\n');
    (child.stdout as PassThrough).write(JSON.stringify({ jsonrpc: '2.0', id: 4, result: {} }) + '\n');

    await expect(promise).resolves.toEqual({ jsonrpc: '2.0', id: 4, result: {} });
  });
});
