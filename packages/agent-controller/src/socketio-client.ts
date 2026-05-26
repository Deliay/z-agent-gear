import { io as createSocketIOClient, type Socket } from 'socket.io-client';
import { hostname, platform } from 'os';
import { readdir, access } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { Heartbeat } from './heartbeat.js';
import { clearConfigKey, saveKeyToConfig, saveEndpointToConfig } from './config.js';
import { acpDetector } from './acp/detector.js';
import { AcpSpawner } from './acp/spawner.js';
import { AcpSessionBridge } from './acp/bridge.js';
import { AcpSyncBridge } from './acp/sync-bridge.js';
import { gitHandler } from './git-handler.js';
import { worktreeHandler } from './worktree-handler.js';
import { fsHandler } from './fs-handler.js';

const CONTROLLER_VERSION = '1.0.0';
const acpBridges = new Map<string, AcpSessionBridge>();

function createSpawner(serverType: string, sessionId: string, cwd: string): AcpSpawner {
  const config = acpDetector.getSpawnerConfig(serverType);
  return new AcpSpawner({ sessionId, cwd, command: config.command, args: config.args });
}

interface RegisteredPayload {
  controllerId: string;
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

interface AcpStartPayload {
  requestId: string;
  sessionId: string;
  serverType: string;
  cwd: string;
  mcpServers?: Array<{ name: string; command: string; args?: string[]; env?: Array<{ name: string; value: string }> }>;
}

interface AcpMessagePayload {
  sessionId: string;
  message: { type: string; content: string };
}

interface AcpCancelPayload {
  sessionId: string;
}

interface AcpStopPayload {
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
}

interface AcpListSessionsPayload {
  requestId: string;
  cwd: string;
}

interface AcpLoadSessionPayload {
  requestId: string;
  sessionId: string;
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

  socket.on('connect', () => {
    console.log(`Connected to ${endpoint}`);
    socket.emit('register', {
      key,
      hostname: controllerName,
      version: CONTROLLER_VERSION,
    });
  });

  socket.on('registered', (data: RegisteredPayload) => {
    console.log(`Controller registered: ${data.controllerId}`);
    heartbeat.start(() => socket.emit('heartbeat'));
  });

  socket.on('error', (data: ErrorPayload) => {
    console.error(`Server error: ${data.code} - ${data.message}`);
    if (data.code === 'KEY_ALREADY_ONLINE') {
      console.error('This key is already in use on another machine.');
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

  socket.on('acp:start', async (data: AcpStartPayload) => {
    console.log(`[ACP ctrl] acp:start received: requestId=${data.requestId} sessionId=${data.sessionId} serverType=${data.serverType} cwd=${data.cwd}`);

    try {
      const spawner = createSpawner(data.serverType, data.sessionId, data.cwd);
      const bridge = new AcpSessionBridge(socket, {
        sessionId: data.sessionId,
        cwd: data.cwd,
        mcpServers: data.mcpServers,
      }, spawner);

      acpBridges.set(data.sessionId, bridge);

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
        if (payload.modes) result.modes = payload.modes;
        if (payload.currentModeId) result.currentModeId = payload.currentModeId;
        if (payload.currentModel) result.currentModel = payload.currentModel;
        if (payload.availableModels) result.availableModels = payload.availableModels;
        if (payload.currentModelId) result.currentModelId = payload.currentModelId;
        socket.emit('acp:start:result', result);
      };

      const onStopped = (payload: { sessionId: string; reason: string; error?: string }) => {
        if (payload.sessionId !== data.sessionId) return;
        bridge.off('acp:initialized', onInitialized);
        bridge.off('acp:stopped', onStopped);
        acpBridges.delete(data.sessionId);
        console.log(`[ACP ctrl] emitting acp:start:result: requestId=${data.requestId} sessionId=${data.sessionId} success=false`);
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
      socket.emit('acp:start:result', {
        requestId: data.requestId,
        sessionId: data.sessionId,
        success: false,
        error: (error as Error).message,
      });
    }
  });

  socket.on('acp:resume', async (data: AcpResumePayload) => {
    console.log(`[ACP ctrl] acp:resume received: requestId=${data.requestId} sessionId=${data.sessionId} serverType=${data.serverType} externalSessionId=${data.externalSessionId}`);

    try {
      const spawner = createSpawner(data.serverType, data.sessionId, data.cwd);
      const bridge = new AcpSessionBridge(socket, {
        sessionId: data.sessionId,
        cwd: data.cwd,
      }, spawner);

      acpBridges.set(data.sessionId, bridge);

      const onInitialized = (payload: Record<string, unknown>) => {
        if (payload.sessionId !== data.sessionId) return;
        bridge.off('acp:initialized', onInitialized);
        bridge.off('acp:stopped', onStopped);
        const result: Record<string, unknown> = {
          requestId: data.requestId,
          sessionId: data.sessionId,
          success: true,
        };
        if (payload.modes) result.modes = payload.modes;
        if (payload.currentModeId) result.currentModeId = payload.currentModeId;
        if (payload.currentModel) result.currentModel = payload.currentModel;
        if (payload.availableModels) result.availableModels = payload.availableModels;
        if (payload.currentModelId) result.currentModelId = payload.currentModelId;
        socket.emit('acp:resume:result', result);
      };

      const onStopped = (payload: { sessionId: string; reason: string; error?: string }) => {
        if (payload.sessionId !== data.sessionId) return;
        bridge.off('acp:initialized', onInitialized);
        bridge.off('acp:stopped', onStopped);
        acpBridges.delete(data.sessionId);
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
      socket.emit('acp:resume:result', {
        requestId: data.requestId,
        sessionId: data.sessionId,
        success: false,
        error: (error as Error).message,
      });
    }
  });

  socket.on('acp:list-sessions', async (data: AcpListSessionsPayload) => {
    console.log(`[ACP sync] acp:list-sessions received: requestId=${data.requestId} cwd=${data.cwd}`);
    const bridge = new AcpSyncBridge({ cwd: data.cwd });
    try {
      await bridge.connect();
      const result = await bridge.listSessions(data.cwd);
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
    console.log(`[ACP] load-session received: requestId=${data.requestId} sessionId=${data.sessionId} cwd=${data.cwd}`);
    const bridge = new AcpSyncBridge({ cwd: data.cwd });
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

  socket.on('acp:stop', (data: AcpStopPayload) => {
    console.log(`ACP stop requested for session ${data.sessionId}`);
    const bridge = acpBridges.get(data.sessionId);
    if (bridge) {
      bridge.stop();
      acpBridges.delete(data.sessionId);
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
    socket.emit('fs:mkdir:result', { requestId: data.requestId, ...result });
  });

  socket.on('git:worktree:add', async (data: GitWorktreeAddPayload) => {
    const result = await worktreeHandler.add(data.repoPath, data.worktreePath, data.branch);
    socket.emit('git:worktree:add:result', { requestId: data.requestId, ...result });
  });

  socket.on('git:worktree:remove', async (data: GitWorktreeRemovePayload) => {
    const result = await worktreeHandler.remove(data.repoPath, data.worktreePath);
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

  socket.on('disconnect', (reason) => {
    console.log(`Disconnected: ${reason}`);
    heartbeat.stop();
  });

  socket.on('connect_error', (err) => {
    console.error(`Connection error: ${err.message}`);
  });

  return socket;
}

export function unregister(socket: Socket): void {
  socket.emit('unregister', { reason: 'user_detach' });
}
