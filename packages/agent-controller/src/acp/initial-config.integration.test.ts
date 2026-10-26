import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcpSessionBridge } from './bridge.js';
import { AcpSpawner } from './spawner.js';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = join(here, '__fixtures__', 'fake-initial-config-agent.mjs');
const SESSION_ID = 'it-initial-config';

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

function readRecords(resultFile: string): Array<Record<string, unknown>> {
  if (!existsSync(resultFile)) return [];
  return readFileSync(resultFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('初始 mode/model 应用确认：真实 SDK + 假 Agent 进程', () => {
  it('T-IC1: session/new 无 configOptions → 异步 config_option_update → 补应用生效 → 结果事件 applied', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-initial-config-'));
    const resultFile = join(dir, 'result.jsonl');
    const spawner = new AcpSpawner({
      sessionId: SESSION_ID,
      cwd: dir,
      command: process.execPath,
      args: [FAKE_AGENT, resultFile],
    });
    const { socket, emitted } = createRecordingSocket();
    const bridge = new AcpSessionBridge(
      socket as never,
      { sessionId: SESSION_ID, cwd: dir, initialModelId: 'requested-model' },
      spawner,
    );
    cleanupFns.push(async () => {
      await bridge.stop().catch(() => {});
      spawner.stop();
    });
    const initialized: unknown[] = [];
    bridge.on('acp:initialized', (payload) => initialized.push(payload));

    await bridge.start();

    // 挂起阶段不阻断会话：initialized 照常发出，结果事件尚未收敛
    expect(initialized).toHaveLength(1);
    expect(emitted.some((e) => e.event === 'acp:initial-config:result')).toBe(false);

    const result = await waitFor(() =>
      emitted.find((e) => e.event === 'acp:initial-config:result'),
    );
    expect(result.payload).toEqual({
      sessionId: SESSION_ID,
      modelId: 'requested-model',
      modelStatus: 'applied',
    });

    // Agent 侧确实收到了补应用的 set_config_option（请求值经真实协议到达对端）
    const records = await waitFor(() => {
      const current = readRecords(resultFile);
      return current.length > 0 ? current : undefined;
    });
    expect(records[0].setConfigOption).toMatchObject({
      sessionId: 'fake-session-1',
      configId: 'model',
      value: 'requested-model',
    });

    // 响应快照刷新后回发 acp:config-options，末次快照 currentValue 为生效值
    const configOptionsEvents = emitted.filter((e) => e.event === 'acp:config-options');
    const last = configOptionsEvents[configOptionsEvents.length - 1];
    expect(last).toBeDefined();
    const options = last.payload.configOptions as Array<{ category: string; currentValue: string }>;
    expect(options.find((o) => o.category === 'model')?.currentValue).toBe('requested-model');

    // 收敛恰好一次
    expect(emitted.filter((e) => e.event === 'acp:initial-config:result')).toHaveLength(1);
  }, 15000);
});
