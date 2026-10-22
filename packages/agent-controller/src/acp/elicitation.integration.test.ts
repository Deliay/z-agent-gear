import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcpSessionBridge } from './bridge.js';
import { AcpSpawner } from './spawner.js';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = join(here, '__fixtures__', 'fake-elicitation-agent.mjs');

interface EmittedEvent {
  event: string;
  payload: Record<string, unknown>;
}

function createRecordingSocket() {
  const emitted: EmittedEvent[] = [];
  const socket = {
    emit: (event: string, payload: Record<string, unknown>) => {
      emitted.push({ event, payload });
      return true;
    },
    on: () => socket,
    off: () => socket,
  };
  return { socket, emitted };
}

async function waitFor<T>(
  fn: () => T | undefined,
  timeoutMs = 6000,
  intervalMs = 20,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = fn();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

const cleanupFns: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanupFns.length > 0) {
    await cleanupFns.pop()?.();
  }
});

function createBridge(mode: string) {
  const dir = mkdtempSync(join(tmpdir(), 'acp-fake-agent-'));
  const resultFile = join(dir, 'result.jsonl');
  const spawner = new AcpSpawner({
    sessionId: `it-${Date.now()}`,
    cwd: dir,
    command: process.execPath,
    args: [FAKE_AGENT, mode, resultFile],
  });
  const { socket, emitted } = createRecordingSocket();
  const bridge = new AcpSessionBridge(
    socket as never,
    { sessionId: `it-${Date.now()}`, cwd: dir },
    spawner,
  );
  cleanupFns.push(async () => {
    await bridge.stop().catch(() => {});
    spawner.stop();
  });
  return { bridge, emitted, resultFile };
}

function readRecords(resultFile: string): Array<Record<string, unknown>> {
  if (!existsSync(resultFile)) return [];
  return readFileSync(resultFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('elicitation 真实 SDK + 假 Agent 进程', () => {
  it('T-BI1: form 模式问询被路由到 unstable_createElicitation，响应回传 Agent', async () => {
    const { bridge, emitted, resultFile } = createBridge('form');

    await bridge.start();

    const elicitation = await waitFor(() =>
      emitted.find((e) => e.event === 'acp:elicitation'),
    );
    expect(elicitation.payload).toMatchObject({
      mode: 'form',
      message: 'Fake agent needs input',
    });

    const requestId = elicitation.payload.requestId as string;
    bridge.handleElicitationResponse(requestId, 'accept', { answer: 'x' });

    const records = await waitFor(() => {
      const current = readRecords(resultFile);
      return current.length > 0 ? current : undefined;
    });
    expect(records[0].elicitationResponse).toEqual({ action: 'accept', content: { answer: 'x' } });
    expect(emitted.some((e) => e.event === 'acp:elicitation:resolved')).toBe(false);
  }, 15000);

  it('T-BI2: 平台未声明模式（custom）返回 cancel 并发出 resolved(unsupported_mode)', async () => {
    const { bridge, emitted, resultFile } = createBridge('custom');

    await bridge.start();

    const records = await waitFor(() => {
      const current = readRecords(resultFile);
      return current.length > 0 ? current : undefined;
    });
    // 未知模式在到达用户前被取消：Agent 收到 cancel
    expect(records[0].elicitationResponse).toEqual({ action: 'cancel' });

    const resolved = emitted.find((e) => e.event === 'acp:elicitation:resolved');
    expect(resolved?.payload).toMatchObject({
      reason: 'unsupported_mode',
      detail: 'custom',
    });
    expect(emitted.some((e) => e.event === 'acp:elicitation')).toBe(false);
  }, 15000);
});
