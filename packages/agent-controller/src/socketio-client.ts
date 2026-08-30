import { io as createSocketIOClient, type Socket } from 'socket.io-client';
import * as acp from '@agentclientprotocol/sdk';
import { hostname, platform } from 'os';
import { readdir, access } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { Heartbeat } from './heartbeat.js';
import { clearConfigKey, saveKeyToConfig, saveEndpointToConfig, getResumeTokenFromConfig, saveResumeTokenToConfig, clearResumeTokenFromConfig } from './config.js';
import { acpDetector } from './acp/detector.js';
import { probeAcpServerOptions } from './acp/prober.js';
import { AcpSpawner } from './acp/spawner.js';
import { AcpSessionBridge } from './acp/bridge.js';
import { AcpSyncBridge } from './acp/sync-bridge.js';
import { gitHandler } from './git-handler.js';
import { worktreeHandler } from './worktree-handler.js';
import { fsHandler } from './fs-handler.js';
import { gatewayManager } from './gateway.js';
import { processRegistry, isProcessAlive } from './acp/process-registry.js';
import { McpRelay } from './mcp/relay.js';
import { LocalMcpServer } from './mcp/local-server.js';

const CONTROLLER_VERSION = '2.0.0';
const acpBridges = new Map<string, AcpSessionBridge>();
const permissionRequestBridge = new Map<string, AcpSessionBridge>();
const elicitationRequestBridge = new Map<string, AcpSessionBridge>();

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function createSpawner(serverType: string, sessionId: string, cwd: string): AcpSpawner {
  const config = acpDetector.getSpawnerConfig(serverType);
  return new AcpSpawner({ sessionId, cwd, command: config.command, args: config.args });
}

interface RegisteredPayload {
  controllerId: string;
  resumeToken?: string;
}

interface ErrorPayload {
  code: string;
  message: string;
}

interface ShutdownPayload {
  reason: string;
}

interface AcpCheckPayload {
  requestId: string;
}

interface AcpProbeOptionsPayload {
  requestId: string;
  serverType: string;
}

interface AcpStartPayload {
  requestId: string;
  sessionId: string;
  serverType: string;
  cwd: string;
  mcpServers?: Array<{ name: string; command: string; args?: string[]; env?: Array<{ name: string; value: string }> }>;
  mcpEndpoint?: { token: string; serverNames: string[] };
  additionalDirectories?: string[];
  modeId?: string;
  modelId?: string;
}

interface AcpMessagePayload {
  sessionId: string;
  message: { type: string; content: string; attachments?: Array<Record<string, unknown>> };
}

// Summarize the MCP configuration of an acp:start/acp:resume payload for logs,
// without leaking the endpoint token.
function describeMcpConfig(data: { mcpServers?: unknown[]; mcpEndpoint?: { serverNames?: string[] } }): string {
  const parts: string[] = [];
  if (data.mcpServers && data.mcpServers.length > 0) {
    parts.push(`mcpServers=${data.mcpServers.length}`);
  }
  if (data.mcpEndpoint) {
    parts.push(`mcpEndpoint(serverNames=${JSON.stringify(data.mcpEndpoint.serverNames ?? null)})`);
  }
  return parts.length > 0 ? `mcp=[${parts.join(' ')}]` : 'mcp=[none]';
}

interface AcpCancelPayload {
  sessionId: string;
}

interface AcpStopPayload {
  sessionId: string;
  ackRequired?: boolean;
}

interface AcpSetConfigOptionPayload {
  sessionId: string;
  configId: string;
  value: string | boolean;
}

interface AcpDeleteHistorySessionPayload {
  requestId: string;
  sessionId: string;
  externalSessionId: string;
  cwd: string;
  serverType?: string;
}

interface AcpAuthenticatePayload {
  sessionId: string;
  methodId: string;
}

interface AcpLogoutPayload {
  sessionId: string;
}

interface AcpSetModePayload {
  sessionId: string;
  modeId: string;
}

interface AcpSetModelPayload {
  sessionId: string;
  modelId: string;
}

interface AcpResumePayload {
  requestId: string;
  sessionId: string;
  externalSessionId: string;
  serverType: string;
  cwd: string;
  mcpEndpoint?: { token: string; serverNames: string[] };
  additionalDirectories?: string[];
  modeId?: string;
  modelId?: string;
}

interface AcpListSessionsPayload {
  requestId: string;
  serverType: string;
  cwd: string;
  cursor?: string | null;
}

interface AcpLoadSessionPayload {
  requestId: string;
  sessionId: string;
  serverType: string;
  cwd: string;
}

interface FsBrowsePayload {
  requestId: string;
  path: string | null;
}

interface FsHomePayload {
  requestId: string;
}

interface GitCheckPayload {
  requestId: string;
  path: string;
}

interface GitInitPayload {
  requestId: string;
  path: string;
}

interface FsMkdirPayload {
  requestId: string;
  parentPath: string;
  folderName: string;
}

interface GitWorktreeAddPayload {
  requestId: string;
  repoPath: string;
  worktreePath: string;
  branch: string;
}

interface GitWorktreeRemovePayload {
  requestId: string;
  repoPath: string;
  worktreePath: string;
}

interface GitStatusPayload {
  requestId: string;
  path: string;
}

interface GitCommitPayload {
  requestId: string;
  path: string;
  message: string;
}

export function connectToServer(
  endpoint: string,
  key: string,
  options?: { serverName?: string },
): Socket {
  const socket = createSocketIOClient(endpoint, {
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 60000,
  });

  const heartbeat = new Heartbeat();
  const controllerName = options?.serverName || hostname();
  const mcpRelay = new McpRelay((payload) => socket.emit('mcp:request', payload));
  const localServer = new LocalMcpServer(mcpRelay);
  // 回环 HTTP 服务在守护进程内只启动一次、进程退出前不停止（提案 Phase 2 要求全守护进程共享一个端口）。
  // 断线快速失败由 mcpRelay.handleDisconnect()（503）承担，无需随 socket 连接启停 HTTP 服务。
  // ready promise 保证 acp:start/acp:resume 读取 localServer.port 前服务已 listening（启动只 await 一次）。
  const mcpServerReady = localServer.start();
  mcpServerReady.catch((err: Error) => {
    console.error(`[MCP] failed to start local MCP endpoint: ${err.message}`);
  });

  // Seed the fs:remove-dir whitelist with cwds of ACP processes that survived
  // a controller restart (their worktrees remain controller-managed).
  for (const entry of processRegistry.listEntries()) {
    fsHandler.registerAllowedPath(entry.cwd);
  }

  socket.on('connect', () => {
    console.log(`Connected to ${endpoint}`);
    const resumeToken = getResumeTokenFromConfig();
    socket.emit('register', {
      key,
      hostname: controllerName,
      version: CONTROLLER_VERSION,
      resumeToken,
      homeDir: homedir(),
      platform: platform(),
    });
  });

  socket.on('registered', (data: RegisteredPayload) => {
    console.log(`Controller registered: ${data.controllerId}`);
    if (data.resumeToken) {
      saveResumeTokenToConfig(data.resumeToken);
      console.log('Resume token saved to config');
    }
    heartbeat.start(() => socket.emit('heartbeat'));
  });

  socket.on('error', (data: ErrorPayload) => {
    console.error(`Server error: ${data.code} - ${data.message}`);
    if (data.code === 'VERSION_MISMATCH') {
      console.error('The agent-controller version is not supported by the server.');
      console.error('Please upgrade agent-controller to 2.x (npm i -g agent-gear@2 or the matching release).');
      socket.disconnect();
      process.exit(1);
      return;
    }
    if (data.code === 'KEY_ALREADY_ONLINE') {
      console.log('Clearing resume token and retrying connection...');
      clearResumeTokenFromConfig();
      // Don't exit, let the reconnection logic handle it
      socket.disconnect();
      return;
    }
    socket.disconnect();
    process.exit(1);
  });

  socket.on('unregistered', () => {
    console.log('Unregistered from server');
    heartbeat.stop();
    clearConfigKey();
    socket.close();
    process.exit(0);
  });

  socket.on('shutdown', (data: ShutdownPayload) => {
    console.log(`Shutdown requested: ${data.reason}`);
    heartbeat.stop();
    clearConfigKey();
    socket.close();
    process.exit(0);
  });

  // ACP events
  socket.on('acp:check', async (data: AcpCheckPayload) => {
    console.log('ACP check requested');
    const servers = await acpDetector.detect();
    socket.emit('acp:check:result', {
      requestId: data.requestId,
      servers,
    });
  });

  // 空实例探测：拉起指定工具的临时会话，收集 Mode/模型选项后关闭
  socket.on('acp:probe-options', async (data: AcpProbeOptionsPayload) => {
    console.log(`[ACP ctrl] acp:probe-options received: requestId=${data.requestId} serverType=${data.serverType}`);
    try {
      const options = await probeAcpServerOptions(data.serverType);
      console.log(`[ACP ctrl] probe-options success: serverType=${data.serverType} modes=${options.modes.length} models=${options.availableModels.length}`);
      socket.emit('acp:probe-options:result', {
        requestId: data.requestId,
        serverType: data.serverType,
        success: true,
        ...options,
      });
    } catch (error) {
      console.warn(`[ACP ctrl] probe-options failed: serverType=${data.serverType} error=${(error as Error).message}`);
      socket.emit('acp:probe-options:result', {
        requestId: data.requestId,
        serverType: data.serverType,
        success: false,
        error: (error as Error).message,
      });
    }
  });

  socket.on('acp:start', async (data: AcpStartPayload) => {
    console.log(`[ACP ctrl] acp:start received: requestId=${data.requestId} sessionId=${data.sessionId} serverType=${data.serverType} cwd=${data.cwd} ${describeMcpConfig(data)}`);

    try {
      // 同 sessionId 重复 start（如 start 超时后的兜底 resume/重试与迟到初始化交叠）：
      // 先停掉旧 bridge，避免同会话双进程、旧 bridge 泄漏
      const existingBridge = acpBridges.get(data.sessionId);
      if (existingBridge) {
        console.warn(`[ACP ctrl] acp:start for session ${data.sessionId} already has a bridge, stopping the previous one`);
        acpBridges.delete(data.sessionId);
        await existingBridge.stop().catch(() => {});
      }
      const spawner = createSpawner(data.serverType, data.sessionId, data.cwd);
      if (data.mcpEndpoint) {
        // 确保回环服务已 listening 后再读取 port 并注入（启动失败时 fail loudly，不静默注入端口 0）
        await mcpServerReady;
        if (localServer.port <= 0) {
          throw new Error(`MCP endpoint unavailable: local loopback server not listening (port=${localServer.port})`);
        }
        mcpRelay.registerSession(data.sessionId, {
          token: data.mcpEndpoint.token,
          serverNames: data.mcpEndpoint.serverNames,
        });
      }
      const bridge = new AcpSessionBridge(socket, {
        sessionId: data.sessionId,
        cwd: data.cwd,
        mcpServers: data.mcpServers,
        mcpEndpoint: data.mcpEndpoint,
        mcpPort: localServer.port,
        additionalDirectories: data.additionalDirectories,
        initialModeId: data.modeId,
        initialModelId: data.modelId,
      }, spawner);

      acpBridges.set(data.sessionId, bridge);

      // The session cwd is a controller-managed worktree: allow fs:remove-dir on it
      fsHandler.registerAllowedPath(data.cwd);
      // Registry lifecycle is bound to the bridge: any stop exit (user close,
      // agent exit, error) deregisters the PID so stale entries cannot pile up
      bridge.on('acp:stopped', (payload: { sessionId: string }) => {
        if (payload.sessionId === data.sessionId) {
          processRegistry.deregister(data.sessionId);
          mcpRelay.unregisterSession(data.sessionId);
        }
      });

      // Register PID in process registry after spawner starts
      const registerPid = () => {
        const pid = spawner.pid;
        if (pid) {
          processRegistry.register(data.sessionId, {
            pid,
            cwd: data.cwd,
            acpServerType: data.serverType,
          });
        }
      };
      // Register immediately if pid already available, otherwise wait for spawn
      registerPid();
      if (!spawner.pid) {
        spawner.closed.then(() => {}).catch(() => {});
        // Poll briefly for pid to appear after spawn
        const pollId = setInterval(() => {
          if (spawner.pid) {
            clearInterval(pollId);
            registerPid();
          }
        }, 50);
        setTimeout(() => clearInterval(pollId), 5000);
      }

      bridge.on('permission:sent', (requestId: string) => {
        permissionRequestBridge.set(requestId, bridge);
      });

      bridge.on('elicitation:sent', (requestId: string) => {
        elicitationRequestBridge.set(requestId, bridge);
      });

      const onInitialized = (payload: Record<string, unknown>) => {
        if (payload.sessionId !== data.sessionId) return;
        bridge.off('acp:initialized', onInitialized);
        bridge.off('acp:stopped', onStopped);
        console.log(`[ACP ctrl] emitting acp:start:result: requestId=${data.requestId} sessionId=${data.sessionId} success=true externalSessionId=${payload.acpSessionId}`);
        const result: Record<string, unknown> = {
          requestId: data.requestId,
          sessionId: data.sessionId,
          success: true,
          externalSessionId: payload.acpSessionId,
        };
        result.modes = payload.modes ?? [];
        if (payload.currentModeId) result.currentModeId = payload.currentModeId;
        if (payload.currentModel) result.currentModel = payload.currentModel;
        result.availableModels = payload.availableModels ?? [];
        if (payload.currentModelId) result.currentModelId = payload.currentModelId;
        result.configOptions = payload.configOptions ?? [];
        if (payload.promptCapabilities) result.promptCapabilities = payload.promptCapabilities;
        if (payload.agentInfo) result.agentInfo = payload.agentInfo;
        if (payload.authMethods) result.authMethods = payload.authMethods;
        if (payload.supportsAdditionalDirectories != null) {
          result.supportsAdditionalDirectories = payload.supportsAdditionalDirectories;
        }
        socket.emit('acp:start:result', result);
      };

      const onStopped = (payload: { sessionId: string; reason: string; error?: string }) => {
        if (payload.sessionId !== data.sessionId) return;
        bridge.off('acp:initialized', onInitialized);
        bridge.off('acp:stopped', onStopped);
        acpBridges.delete(data.sessionId);
        processRegistry.deregister(data.sessionId);
        mcpRelay.unregisterSession(data.sessionId);
        console.log(`[ACP ctrl] emitting acp:start:result: requestId=${data.requestId} sessionId=${data.sessionId} success=false reason=${payload.reason} error=${payload.error ?? 'n/a'}`);
        socket.emit('acp:start:result', {
          requestId: data.requestId,
          sessionId: data.sessionId,
          success: false,
          error: payload.error ?? `ACP process stopped during initialization: ${payload.reason}`,
        });
      };

      bridge.on('acp:initialized', onInitialized);
      bridge.on('acp:stopped', onStopped);

      console.log(`[ACP ctrl] calling bridge.start() for session ${data.sessionId}`);
      await bridge.start();
    } catch (error) {
      console.error(`[ACP ctrl] bridge.start() failed: ${(error as Error).message}`);
      mcpRelay.unregisterSession(data.sessionId);
      socket.emit('acp:start:result', {
        requestId: data.requestId,
        sessionId: data.sessionId,
        success: false,
        error: (error as Error).message,
      });
    }
  });

  socket.on('acp:resume', async (data: AcpResumePayload) => {
    console.log(`[ACP ctrl] acp:resume received: requestId=${data.requestId} sessionId=${data.sessionId} serverType=${data.serverType} externalSessionId=${data.externalSessionId} ${describeMcpConfig(data)}`);

    try {
      // 同 sessionId 重复 resume/start：先停掉旧 bridge（同 acp:start 的防双进程处理）
      const existingBridge = acpBridges.get(data.sessionId);
      if (existingBridge) {
        console.warn(`[ACP ctrl] acp:resume for session ${data.sessionId} already has a bridge, stopping the previous one`);
        acpBridges.delete(data.sessionId);
        await existingBridge.stop().catch(() => {});
      }
      const spawner = createSpawner(data.serverType, data.sessionId, data.cwd);
      if (data.mcpEndpoint) {
        // 确保回环服务已 listening 后再读取 port 并注入（启动失败时 fail loudly，不静默注入端口 0）
        await mcpServerReady;
        if (localServer.port <= 0) {
          throw new Error(`MCP endpoint unavailable: local loopback server not listening (port=${localServer.port})`);
        }
        mcpRelay.registerSession(data.sessionId, {
          token: data.mcpEndpoint.token,
          serverNames: data.mcpEndpoint.serverNames,
        });
      }
      const bridge = new AcpSessionBridge(socket, {
        sessionId: data.sessionId,
        cwd: data.cwd,
        mcpEndpoint: data.mcpEndpoint,
        mcpPort: localServer.port,
        additionalDirectories: data.additionalDirectories,
        // 初始 mode/model：resume 完成后、acp:initialized 之前应用（时序同 acp:start）
        initialModeId: data.modeId,
        initialModelId: data.modelId,
      }, spawner);

      acpBridges.set(data.sessionId, bridge);

      fsHandler.registerAllowedPath(data.cwd);
      bridge.on('acp:stopped', (payload: { sessionId: string }) => {
        if (payload.sessionId === data.sessionId) {
          processRegistry.deregister(data.sessionId);
          mcpRelay.unregisterSession(data.sessionId);
        }
      });

      bridge.on('permission:sent', (requestId: string) => {
        permissionRequestBridge.set(requestId, bridge);
      });

      bridge.on('elicitation:sent', (requestId: string) => {
        elicitationRequestBridge.set(requestId, bridge);
      });

      const onInitialized = (payload: Record<string, unknown>) => {
        if (payload.sessionId !== data.sessionId) return;
        bridge.off('acp:initialized', onInitialized);
        bridge.off('acp:stopped', onStopped);
        const result: Record<string, unknown> = {
          requestId: data.requestId,
          sessionId: data.sessionId,
          success: true,
        };
        result.modes = payload.modes ?? [];
        if (payload.currentModeId) result.currentModeId = payload.currentModeId;
        if (payload.currentModel) result.currentModel = payload.currentModel;
        result.availableModels = payload.availableModels ?? [];
        if (payload.currentModelId) result.currentModelId = payload.currentModelId;
        result.configOptions = payload.configOptions ?? [];
        if (payload.promptCapabilities) result.promptCapabilities = payload.promptCapabilities;
        if (payload.agentInfo) result.agentInfo = payload.agentInfo;
        if (payload.authMethods) result.authMethods = payload.authMethods;
        socket.emit('acp:resume:result', result);
      };

      const onStopped = (payload: { sessionId: string; reason: string; error?: string }) => {
        if (payload.sessionId !== data.sessionId) return;
        bridge.off('acp:initialized', onInitialized);
        bridge.off('acp:stopped', onStopped);
        acpBridges.delete(data.sessionId);
        processRegistry.deregister(data.sessionId);
        mcpRelay.unregisterSession(data.sessionId);
        console.log(`[ACP ctrl] emitting acp:resume:result: requestId=${data.requestId} sessionId=${data.sessionId} success=false reason=${payload.reason} error=${payload.error ?? 'n/a'}`);
        socket.emit('acp:resume:result', {
          requestId: data.requestId,
          sessionId: data.sessionId,
          success: false,
          error: payload.error ?? `ACP resume failed: ${payload.reason}`,
        });
      };

      bridge.on('acp:initialized', onInitialized);
      bridge.on('acp:stopped', onStopped);

      await bridge.resume(data.externalSessionId);
    } catch (error) {
      console.error(`[ACP ctrl] bridge.resume() failed: ${(error as Error).message}`);
      mcpRelay.unregisterSession(data.sessionId);
      socket.emit('acp:resume:result', {
        requestId: data.requestId,
        sessionId: data.sessionId,
        success: false,
        error: (error as Error).message,
      });
    }
  });

  socket.on('acp:list-sessions', async (data: AcpListSessionsPayload) => {
    const serverType = data.serverType ?? 'opencode';
    console.log(`[ACP sync] acp:list-sessions received: requestId=${data.requestId} serverType=${serverType} cwd=${data.cwd}`);
    const spawner = createSpawner(serverType, `sync_${Date.now()}`, data.cwd);
    const bridge = new AcpSyncBridge({ cwd: data.cwd }, spawner);
    try {
      await bridge.connect();
      const result = await bridge.listSessions(data.cwd, data.cursor);
      await bridge.disconnect();
      socket.emit('acp:list-sessions:result', {
        requestId: data.requestId,
        success: true,
        sessions: (result.sessions ?? []).map((s) => ({
          sessionId: s.sessionId,
          title: s.title ?? null,
          cwd: s.cwd,
          updatedAt: s.updatedAt ?? null,
        })),
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
      });
    } catch (error) {
      await bridge.disconnect().catch(() => {});
      console.error(`[ACP sync] list-sessions failed: ${(error as Error).message}`);
      socket.emit('acp:list-sessions:result', {
        requestId: data.requestId,
        success: false,
        error: (error as Error).message,
      });
    }
  });

  socket.on('acp:load-session', async (data: AcpLoadSessionPayload) => {
    const serverType = data.serverType ?? 'opencode';
    console.log(`[ACP] load-session received: requestId=${data.requestId} sessionId=${data.sessionId} serverType=${serverType} cwd=${data.cwd}`);
    const spawner = createSpawner(serverType, `sync_${Date.now()}`, data.cwd);
    const bridge = new AcpSyncBridge({ cwd: data.cwd }, spawner);
    try {
      await bridge.connect();
      const { config, updates } = await bridge.loadSession(data.sessionId, data.cwd);
      await bridge.disconnect(data.sessionId);

      let title: string | null = null;
      const messages: Array<{ direction: 'input' | 'output'; type: string; content: string }> = [];

      for (const notification of updates) {
        const update = notification.update;
        let direction: 'input' | 'output';
        let type: string;

        switch (update.sessionUpdate) {
          case 'user_message_chunk':
            direction = 'input';
            type = 'text';
            break;
          case 'agent_message_chunk':
            direction = 'output';
            type = 'text';
            break;
          case 'tool_call':
          case 'tool_call_update':
            direction = 'output';
            type = 'tool_call';
            break;
          case 'plan':
            direction = 'output';
            type = 'plan';
            break;
          case 'session_info_update':
            direction = 'output';
            type = 'text';
            title = update.title ?? title;
            break;
          case 'usage_update':
          case 'config_option_update':
          case 'current_mode_update':
          case 'available_commands_update':
          default:
            direction = 'output';
            type = 'text';
            break;
        }

        messages.push({
          direction,
          type,
          content: JSON.stringify(update),
        });
      }

      socket.emit('acp:load-session:result', {
        requestId: data.requestId,
        success: true,
        sessionId: data.sessionId,
        title,
      });

      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        socket.emit('acp:load-session:message', {
          requestId: data.requestId,
          direction: msg.direction,
          type: msg.type,
          content: msg.content,
        });
        if (i % 200 === 0) {
          await new Promise(r => setTimeout(r, 0));
        }
      }
      await new Promise(r => setTimeout(r, 5));
      socket.emit('acp:load-session:complete', { requestId: data.requestId });
    } catch (error) {
      await bridge.disconnect(data.sessionId).catch(() => {});
      console.error(`[ACP] load-session FAILED: ${(error as Error).message}`);
      console.log(`[ACP] emitting error result, socket.connected=${socket.connected}`);
      socket.emit('acp:load-session:result', {
        requestId: data.requestId,
        success: false,
        sessionId: data.sessionId,
        error: (error as Error).message,
      });
    }
  });

  socket.on('acp:message', (data: AcpMessagePayload) => {
    const bridge = acpBridges.get(data.sessionId);
    if (bridge) {
      bridge.sendInput(data.message);
    }
  });

  socket.on('acp:cancel', (data: AcpCancelPayload) => {
    const bridge = acpBridges.get(data.sessionId);
    if (bridge) {
      bridge.cancel();
    }
  });

  socket.on('acp:stop', async (data: AcpStopPayload) => {
    if (!data || typeof data.sessionId !== 'string') {
      console.warn(`[ACP ctrl] acp:stop ignored: invalid payload ${JSON.stringify(data)}`);
      return;
    }
    console.log(`ACP stop requested for session ${data.sessionId} ackRequired=${data.ackRequired ?? false}`);
    const bridge = acpBridges.get(data.sessionId);
    let killedByRegistry = false;
    if (bridge) {
      await bridge.stop();
      acpBridges.delete(data.sessionId);
    } else {
      // Bridge not found: fallback to registry PID kill
      const entry = processRegistry.get(data.sessionId);
      if (entry) {
        console.log(`[ACP ctrl] bridge not found for session ${data.sessionId}, killing by PID ${entry.pid}`);
        killedByRegistry = true;
        try {
          if (platform() === 'win32') {
            const { execFile } = await import('child_process');
            await new Promise<void>((resolve) => {
              execFile('taskkill', ['/PID', String(entry.pid), '/T', '/F'], () => resolve());
            });
          } else {
            process.kill(-entry.pid, 'SIGTERM');
            setTimeout(() => {
              // Probe before SIGKILL: the PID may have been reused after exit
              if (!isProcessAlive(entry.pid)) return;
              try { process.kill(-entry.pid, 'SIGKILL'); } catch { /* already dead */ }
            }, 5000);
          }
        } catch { /* process may already be dead */ }
        processRegistry.deregister(data.sessionId);
      }
    }
    mcpRelay.unregisterSession(data.sessionId);
    if (data.ackRequired) {
      socket.emit('acp:stopped', {
        sessionId: data.sessionId,
        reason: 'user_close',
        killed: killedByRegistry,
      });
    }
  });

  socket.on('acp:set-mode', (data: AcpSetModePayload) => {
    console.log(`[ACP] acp:set-mode received: sessionId=${data.sessionId} modeId=${data.modeId}`);
    const bridge = acpBridges.get(data.sessionId);
    if (bridge) {
      bridge.setMode(data.modeId).catch((err) => {
        console.error(`[ACP] setMode failed: ${(err as Error).message}`);
      });
    }
  });

  socket.on('acp:set-model', (data: AcpSetModelPayload) => {
    console.log(`[ACP] acp:set-model received: sessionId=${data.sessionId} modelId=${data.modelId}`);
    const bridge = acpBridges.get(data.sessionId);
    if (bridge) {
      bridge.setModel(data.modelId).catch((err) => {
        console.error(`[ACP] setModel failed: ${(err as Error).message}`);
      });
    }
  });

  socket.on('acp:set-config-option', (data: AcpSetConfigOptionPayload) => {
    console.log(`[ACP] acp:set-config-option received: sessionId=${data.sessionId} configId=${data.configId}`);
    const bridge = acpBridges.get(data.sessionId);
    if (!bridge) {
      socket.emit('acp:set-config-option:result', {
        sessionId: data.sessionId,
        success: false,
        configId: data.configId,
        error: 'ACP bridge not found for session',
      });
      return;
    }
    // 成功时 bridge 内部已用响应快照更新 configOptions 并 emit acp:config-options
    bridge.setConfigOption(data.configId, data.value).then(
      () => {
        socket.emit('acp:set-config-option:result', {
          sessionId: data.sessionId,
          success: true,
          configId: data.configId,
        });
      },
      (err) => {
        console.error(`[ACP] setConfigOption failed: ${(err as Error).message}`);
        socket.emit('acp:set-config-option:result', {
          sessionId: data.sessionId,
          success: false,
          configId: data.configId,
          error: (err as Error).message,
        });
      },
    );
  });

  socket.on('acp:delete-history-session', async (data: AcpDeleteHistorySessionPayload) => {
    const serverType = data.serverType ?? 'opencode';
    console.log(`[ACP sync] acp:delete-history-session received: sessionId=${data.externalSessionId} cwd=${data.cwd}`);
    const spawner = createSpawner(serverType, `sync_${Date.now()}`, data.cwd);
    const bridge = new AcpSyncBridge({ cwd: data.cwd }, spawner);
    try {
      await bridge.connect();
      if (!bridge.supportsDelete()) {
        await bridge.disconnect().catch(() => {});
        socket.emit('acp:delete-history-session:result', {
          requestId: data.requestId,
          sessionId: data.sessionId,
          success: false,
          supported: false,
          error: 'Session delete not supported by agent',
        });
        return;
      }
      await bridge.deleteSession(data.externalSessionId);
      await bridge.disconnect();
      socket.emit('acp:delete-history-session:result', {
        requestId: data.requestId,
        sessionId: data.sessionId,
        success: true,
        supported: true,
      });
    } catch (error) {
      await bridge.disconnect().catch(() => {});
      console.error(`[ACP sync] delete-history-session failed: ${(error as Error).message}`);
      socket.emit('acp:delete-history-session:result', {
        requestId: data.requestId,
        sessionId: data.sessionId,
        success: false,
        supported: true,
        error: (error as Error).message,
      });
    }
  });

  socket.on('acp:authenticate', async (data: AcpAuthenticatePayload) => {
    console.log(`[ACP] acp:authenticate received: sessionId=${data.sessionId} methodId=${data.methodId}`);
    const bridge = acpBridges.get(data.sessionId);
    try {
      if (!bridge) throw new Error('ACP bridge not found for session');
      await bridge.authenticate(data.methodId);
      socket.emit('acp:authenticate:result', {
        sessionId: data.sessionId,
        success: true,
      });
    } catch (error) {
      console.error(`[ACP] authenticate failed: ${(error as Error).message}`);
      socket.emit('acp:authenticate:result', {
        sessionId: data.sessionId,
        success: false,
        error: (error as Error).message,
      });
    }
  });

  socket.on('acp:logout', async (data: AcpLogoutPayload) => {
    console.log(`[ACP] acp:logout received: sessionId=${data.sessionId}`);
    const bridge = acpBridges.get(data.sessionId);
    try {
      if (!bridge) throw new Error('ACP bridge not found for session');
      await bridge.logout();
      socket.emit('acp:logout:result', {
        sessionId: data.sessionId,
        success: true,
      });
    } catch (error) {
      console.error(`[ACP] logout failed: ${(error as Error).message}`);
      socket.emit('acp:logout:result', {
        sessionId: data.sessionId,
        success: false,
        error: (error as Error).message,
      });
    }
  });

  // File system events
  socket.on('fs:browse', async (data: FsBrowsePayload) => {
    console.log(`FS browse requested: requestId=${data.requestId} path=${data.path}`);
    try {
      const targetPath = data.path || homedir();

      // On Windows, listing '/' should return available drive letters
      if ((data.path === '/' || data.path === '') && platform() === 'win32') {
        const drives: Array<{ name: string; path: string; isDirectory: boolean }> = [];
        for (let i = 65; i <= 90; i++) {
          const letter = String.fromCharCode(i);
          const drivePath = `${letter}:\\`;
          try {
            await access(drivePath);
            drives.push({ name: `${letter}:`, path: drivePath, isDirectory: true });
          } catch { /* drive not available */ }
        }
        socket.emit('fs:browse:result', { requestId: data.requestId, entries: drives });
        return;
      }

      const entries = await readdir(targetPath, { withFileTypes: true });
      const result = entries
        .filter((entry) => !entry.name.startsWith('.'))
        .map((entry) => ({
          name: entry.name,
          path: join(targetPath, entry.name),
          isDirectory: entry.isDirectory(),
        }))
        .sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      socket.emit('fs:browse:result', { requestId: data.requestId, entries: result });
    } catch (error) {
      console.error(`FS browse error: ${(error as Error).message}`);
      socket.emit('fs:browse:result', { requestId: data.requestId, entries: [] });
    }
  });

  socket.on('fs:home', async (data: FsHomePayload) => {
    console.log(`FS home requested: requestId=${data.requestId}`);
    const homePath = homedir();
    socket.emit('fs:home:result', { requestId: data.requestId, path: homePath });
  });

  socket.on('git:check', async (data: GitCheckPayload) => {
    const result = await gitHandler.check(data.path);
    socket.emit('git:check:result', { requestId: data.requestId, ...result });
  });

  socket.on('git:init', async (data: GitInitPayload) => {
    const result = await gitHandler.init(data.path);
    socket.emit('git:init:result', { requestId: data.requestId, ...result });
  });

  // Worktree / Git extension events
  socket.on('fs:mkdir', async (data: FsMkdirPayload) => {
    const result = await fsHandler.mkdir(data.parentPath, data.folderName);
    if (result.success && result.path) {
      fsHandler.registerAllowedPath(result.path);
    }
    socket.emit('fs:mkdir:result', { requestId: data.requestId, ...result });
  });

  socket.on('git:worktree:add', async (data: GitWorktreeAddPayload) => {
    const result = await worktreeHandler.add(data.repoPath, data.worktreePath, data.branch);
    if (result.success) {
      fsHandler.registerAllowedPath(data.worktreePath);
    }
    socket.emit('git:worktree:add:result', { requestId: data.requestId, ...result });
  });

  socket.on('git:worktree:remove', async (data: GitWorktreeRemovePayload & { force?: boolean }) => {
    const result = await worktreeHandler.remove(data.repoPath, data.worktreePath, data.force);
    socket.emit('git:worktree:remove:result', { requestId: data.requestId, ...result });
  });

  socket.on('git:status', async (data: GitStatusPayload) => {
    const result = await worktreeHandler.status(data.path);
    socket.emit('git:status:result', { requestId: data.requestId, ...result });
  });

  socket.on('git:commit', async (data: GitCommitPayload) => {
    const result = await worktreeHandler.commit(data.path, data.message);
    socket.emit('git:commit:result', { requestId: data.requestId, ...result });
  });

  // Worktree list event
  socket.on('git:worktree:list', async (data: { requestId: string; workspacePath: string }) => {
    console.log(`[ACP ctrl] git:worktree:list received: requestId=${data.requestId} workspacePath=${data.workspacePath}`);
    const result = await worktreeHandler.list(data.workspacePath);
    socket.emit('git:worktree:list:result', { requestId: data.requestId, ...result });
  });

  // FS remove-dir event
  socket.on('fs:remove-dir', async (data: { requestId: string; path: string }) => {
    console.log(`[ACP ctrl] fs:remove-dir received: requestId=${data.requestId} path=${data.path}`);
    const result = await fsHandler.removeDir(data.path);
    if (result.success) {
      fsHandler.unregisterAllowedPath(data.path);
    }
    socket.emit('fs:remove-dir:result', { requestId: data.requestId, ...result });
  });

  // Reconnection reconciliation
  socket.on('acp:reconcile', async (data: { activeSessionIds: string[]; pendingKillSessionIds: string[] }) => {
    if (!data || !isStringArray(data.activeSessionIds) || !isStringArray(data.pendingKillSessionIds)) {
      console.warn(`[ACP ctrl] acp:reconcile ignored: invalid payload ${JSON.stringify(data)}`);
      return;
    }
    console.log(`[ACP ctrl] acp:reconcile received: active=${data.activeSessionIds.length} pendingKill=${data.pendingKillSessionIds.length}`);
    const registered = processRegistry.listEntries();
    for (const entry of registered) {
      const shouldKill = data.pendingKillSessionIds.includes(entry.sessionId) || !data.activeSessionIds.includes(entry.sessionId);
      if (shouldKill) {
        console.log(`[ACP ctrl] reconcile: killing session=${entry.sessionId} pid=${entry.pid} (pendingKill=${data.pendingKillSessionIds.includes(entry.sessionId)})`);
        try {
          if (platform() === 'win32') {
            const { execFile } = await import('child_process');
            await new Promise<void>((resolve) => {
              execFile('taskkill', ['/PID', String(entry.pid), '/T', '/F'], () => resolve());
            });
          } else {
            process.kill(-entry.pid, 'SIGTERM');
            setTimeout(() => {
              // Probe before SIGKILL: the PID may have been reused after exit
              if (!isProcessAlive(entry.pid)) return;
              try { process.kill(-entry.pid, 'SIGKILL'); } catch { /* already dead */ }
            }, 5000);
          }
        } catch { /* process may already be dead */ }
        processRegistry.deregister(entry.sessionId);
        mcpRelay.unregisterSession(entry.sessionId);
        // Also clean up bridge if present
        const bridge = acpBridges.get(entry.sessionId);
        if (bridge) {
          acpBridges.delete(entry.sessionId);
        }
      }
    }
  });

  // Port Forward events (event names kept unchanged for backward compatibility)
  socket.on('port-forward:create', async (data: { tunnelId: string; port: number }) => {
    console.log(`Gateway tunnel create requested: tunnelId=${data.tunnelId} port=${data.port}`);
    await gatewayManager.createTunnel(data.tunnelId, data.port, socket);
  });

  socket.on('port-forward:data', (data: { tunnelId: string; data: string }) => {
    gatewayManager.handleTunnelData(data.tunnelId, data.data);
  });

  socket.on('port-forward:close', (data: { tunnelId: string }) => {
    console.log(`Gateway tunnel close: tunnelId=${data.tunnelId}`);
    gatewayManager.closeTunnel(data.tunnelId);
  });

  socket.on('acp:permission:response', (data: {
    requestId: string;
    outcome: { outcome: string; optionId?: string };
  }) => {
    const bridge = permissionRequestBridge.get(data.requestId);
    if (bridge) {
      permissionRequestBridge.delete(data.requestId);
      bridge.handlePermissionResponse(data.requestId, data.outcome as acp.RequestPermissionOutcome);
    }
  });

  socket.on('acp:elicitation:response', (data: {
    requestId: string;
    action: 'accept' | 'decline' | 'cancel';
    content?: Record<string, unknown>;
  }) => {
    const bridge = elicitationRequestBridge.get(data.requestId);
    if (bridge) {
      elicitationRequestBridge.delete(data.requestId);
      bridge.handleElicitationResponse(data.requestId, data.action, data.content);
    }
  });

  socket.on('mcp:response', (data: { requestId: string; status: number; body: unknown }) => {
    mcpRelay.handleMcpResponse(data.requestId, data.status, data.body);
  });

  socket.on('disconnect', (reason) => {
    console.log(`Disconnected: ${reason}`);
    heartbeat.stop();
    gatewayManager.closeAll();
    permissionRequestBridge.clear();
    elicitationRequestBridge.clear();
    mcpRelay.handleDisconnect();
  });

  socket.on('connect_error', (err) => {
    console.error(`Connection error: ${err.message}`);
  });

  return socket;
}

export function unregister(socket: Socket): void {
  socket.emit('unregister', { reason: 'user_detach' });
}
