import { io as createSocketIOClient, type Socket } from 'socket.io-client';
import { hostname } from 'os';
import { readdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { Heartbeat } from './heartbeat.js';
import { clearConfigKey, saveKeyToConfig, saveEndpointToConfig } from './config.js';
import { acpDetector } from './acp/detector.js';
import { AcpSessionBridge } from './acp/bridge.js';

const CONTROLLER_VERSION = '1.0.0';
const acpBridges = new Map<string, AcpSessionBridge>();

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

interface AcpResumePayload {
  requestId: string;
  sessionId: string;
  externalSessionId: string;
  cwd: string;
}

interface FsBrowsePayload {
  requestId: string;
  path: string | null;
}

interface FsHomePayload {
  requestId: string;
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
    console.log(`[ACP ctrl] acp:start received: requestId=${data.requestId} sessionId=${data.sessionId} cwd=${data.cwd}`);

    try {
      const bridge = new AcpSessionBridge(socket, {
        sessionId: data.sessionId,
        cwd: data.cwd,
        mcpServers: data.mcpServers,
      });

      acpBridges.set(data.sessionId, bridge);

      const onInitialized = (payload: { sessionId: string; acpSessionId: string }) => {
        if (payload.sessionId !== data.sessionId) return;
        bridge.off('acp:initialized', onInitialized);
        bridge.off('acp:stopped', onStopped);
        console.log(`[ACP ctrl] emitting acp:start:result: requestId=${data.requestId} sessionId=${data.sessionId} success=true externalSessionId=${payload.acpSessionId}`);
        socket.emit('acp:start:result', {
          requestId: data.requestId,
          sessionId: data.sessionId,
          success: true,
          externalSessionId: payload.acpSessionId,
        });
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
    console.log(`[ACP ctrl] acp:resume received: requestId=${data.requestId} sessionId=${data.sessionId} externalSessionId=${data.externalSessionId}`);

    try {
      const bridge = new AcpSessionBridge(socket, {
        sessionId: data.sessionId,
        cwd: data.cwd,
      });

      acpBridges.set(data.sessionId, bridge);

      const onInitialized = (payload: { sessionId: string }) => {
        if (payload.sessionId !== data.sessionId) return;
        bridge.off('acp:initialized', onInitialized);
        bridge.off('acp:stopped', onStopped);
        socket.emit('acp:resume:result', {
          requestId: data.requestId,
          sessionId: data.sessionId,
          success: true,
        });
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

  // File system events
  socket.on('fs:browse', async (data: FsBrowsePayload) => {
    console.log(`FS browse requested: requestId=${data.requestId} path=${data.path}`);
    try {
      const targetPath = data.path || homedir();
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
