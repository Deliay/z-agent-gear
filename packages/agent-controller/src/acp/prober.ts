import { homedir } from 'os';
import type { Socket } from 'socket.io-client';
import { acpDetector } from './detector.js';
import { AcpSpawner } from './spawner.js';
import { AcpSessionBridge, type AcpInitializedPayload } from './bridge.js';

export interface AcpServerOptionsProbeResult {
  modes: Array<{ id: string; name: string; description?: string }>;
  availableModels: Array<{ id: string; name: string; provider?: string }>;
  currentModeId: string | null;
  currentModelId: string | null;
}

/**
 * 空实例探测：临时拉起指定 ACP 工具进程（initialize + session/new），
 * 收集 Mode/模型选项后立即关闭。用于配置阶段动态获取可选选项，
 * 避免用户手填 modeId/modelId。
 *
 * 探测会话不与服务端交互：bridge 发出的 socket 事件全部丢弃。
 * 任一环节失败（CLI 不存在 / 需要认证 / 超时）都会 reject，由调用方降级处理。
 */
export async function probeAcpServerOptions(
  serverType: string,
  timeoutMs = 20000,
): Promise<AcpServerOptionsProbeResult> {
  const sessionId = `probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const config = acpDetector.getSpawnerConfig(serverType);
  const cwd = homedir();
  const spawner = new AcpSpawner({ sessionId, cwd, command: config.command, args: config.args });
  const noopSocket = { emit: () => false } as unknown as Socket;
  const bridge = new AcpSessionBridge(noopSocket, { sessionId, cwd }, spawner);

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`probe timeout after ${timeoutMs}ms: ${serverType}`)));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      bridge.stop().catch(() => { /* ignore */ });
      spawner.stop();
    };

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    bridge.on('acp:initialized', (payload: AcpInitializedPayload) => {
      finish(() =>
        resolve({
          modes: payload.modes ?? [],
          availableModels: payload.availableModels ?? [],
          currentModeId: payload.currentModeId ?? null,
          currentModelId: payload.currentModelId ?? null,
        }),
      );
    });

    bridge.on('acp:stopped', (payload: { reason: string; error?: string }) => {
      finish(() =>
        reject(new Error(payload.error ?? `ACP process stopped during probe: ${payload.reason}`)),
      );
    });

    bridge.start().catch((error: unknown) => {
      finish(() => reject(error instanceof Error ? error : new Error(String(error))));
    });
  });
}
