/**
 * 手动复现脚本（不参与 `npm test`，vitest 只收集 *.test.ts / *.spec.ts）：
 * 「Agent 调用 question 工具后立即报 The user dismissed this question」。
 *
 * 为什么需要它：question 工具的失败文案由 OpenCode 侧产生，单元测试里的假 Agent
 * 无法复刻「elicitation 被 cancel → form cancel → CancelledError」这条真实映射，
 * 必须用真实 `opencode acp` 进程 + 真实 AcpSessionBridge 观测。
 *
 * 前置条件：
 * - 本机已安装 `opencode`（>= 2.1.x），且 ~/.config/opencode 已配置可用模型；
 * - 已 `npm ci`（需要 @agentclientprotocol/sdk）。
 *
 * 用法（在 packages/agent-controller 目录）：
 *   npx tsx tests/manual/repro-question-tool.ts <policy> [prompt]
 *
 *   policy = none    不响应问询（观测 65s bridge 超时后的工具结果）
 *            accept  收到问询立即 accept（对照组：question 工具应 completed）
 *            decline 收到问询立即 decline
 *            cancel  收到问询立即 cancel（秒级复现 "dismissed"）
 *
 * 环境变量：
 *   REPRO_MODEL  指定模型（形如 zag/deepseek-v4.1-flash），不设则由 OpenCode 默认模型决定。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcpSessionBridge } from '../../src/acp/bridge.js';
import { AcpSpawner } from '../../src/acp/spawner.js';

type Policy = 'none' | 'accept' | 'decline' | 'cancel';

const policy = (process.argv[2] ?? 'none') as Policy;
const promptText =
  process.argv[3] ?? '请用 question 工具向我提一个单选题（3 个选项），问完就停下等我回答。';

if (!['none', 'accept', 'decline', 'cancel'].includes(policy)) {
  console.error(`unknown policy: ${policy}`);
  process.exit(2);
}

const cwd = mkdtempSync(join(tmpdir(), 'repro-question-'));
const startedAt = Date.now();
const log = (...args: unknown[]) => console.log(`[${Date.now() - startedAt}ms]`, ...args);

let bridge: AcpSessionBridge;

const socket = {
  emit(event: string, payload: Record<string, unknown>) {
    log('emit', event, JSON.stringify(payload).slice(0, 1200));

    if (event === 'acp:elicitation' && policy !== 'none') {
      const requestId = payload.requestId as string;
      setTimeout(() => {
        log('-> respond elicitation', requestId, policy);
        bridge.handleElicitationResponse(
          requestId,
          policy,
          policy === 'accept' ? { q0: 'A' } : undefined,
        );
      }, 50);
    }

    if (event === 'acp:permission' && policy !== 'none') {
      const requestId = payload.requestId as string;
      const options = payload.options as Array<{ optionId: string; kind?: string }> | undefined;
      const allow = options?.find((o) => o.kind === 'allow_once' || o.kind === 'allow_always') ?? options?.[0];
      setTimeout(() => {
        log('-> respond permission', requestId, allow?.optionId);
        bridge.handlePermissionResponse(
          requestId,
          allow ? { outcome: 'selected', optionId: allow.optionId } : { outcome: 'cancelled' },
        );
      }, 50);
    }
    return true;
  },
  on() { return socket; },
  off() { return socket; },
};

const spawner = new AcpSpawner({ sessionId: `repro-${Date.now()}`, cwd });
bridge = new AcpSessionBridge(
  socket as never,
  {
    sessionId: `repro-${Date.now()}`,
    cwd,
    ...(process.env.REPRO_MODEL ? { initialModelId: process.env.REPRO_MODEL } : {}),
  } as never,
  spawner,
);

async function main(): Promise<void> {
  log('bridge.start()', { cwd, policy });
  await bridge.start();
  log('bridge started');
  bridge.sendInput({ type: 'text', content: promptText });
  log('prompt sent');

  await new Promise<void>((resolve) => {
    // 65s bridge 超时 + 余量
    const timer = setTimeout(() => { log('TIMEOUT 100s'); resolve(); }, 100_000);
    bridge.on('acp:stopped', () => {
      log('bridge stopped');
      clearTimeout(timer);
      resolve();
    });
  });

  await bridge.stop().catch(() => {});
  spawner.stop();
  setTimeout(() => process.exit(0), 300);
}

main().catch((error) => {
  console.error('repro failed', error);
  spawner.stop();
  process.exit(1);
});
