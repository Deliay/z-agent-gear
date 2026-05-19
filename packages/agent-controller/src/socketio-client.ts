import { io as createSocketIOClient, type Socket } from 'socket.io-client';
import { hostname } from 'os';
import { Heartbeat } from './heartbeat.js';
import { clearConfigKey, saveKeyToConfig, saveEndpointToConfig } from './config.js';
import { acpDetector } from './acp/detector.js';
import { AcpWebSocketBridge } from './acp/bridge.js';

const CONTROLLER_VERSION = '1.0.0';
const acpBridges = new Map<string, AcpWebSocketBridge>();

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

interface AcpStopPayload {
  sessionId: string;
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

  socket.on('acp:start', (data: AcpStartPayload) => {
    console.log(`ACP start requested for session ${data.sessionId}`);
    
    try {
      const bridge = new AcpWebSocketBridge(socket, {
        sessionId: data.sessionId,
        controllerId: '',
        cwd: data.cwd,
        mcpServers: data.mcpServers,
      });

      acpBridges.set(data.sessionId, bridge);

      const onInitialized = (payload: { sessionId: string; acpSessionId: string }) => {
        if (payload.sessionId !== data.sessionId) return;
        socket.off('acp:initialized', onInitialized);
        socket.off('acp:stopped', onStopped);
        socket.emit('acp:start:result', {
          requestId: data.requestId,
          sessionId: data.sessionId,
          success: true,
        });
      };

      const onStopped = (payload: { sessionId: string; reason: string; error?: string }) => {
        if (payload.sessionId !== data.sessionId) return;
        socket.off('acp:initialized', onInitialized);
        socket.off('acp:stopped', onStopped);
        acpBridges.delete(data.sessionId);
        socket.emit('acp:start:result', {
          requestId: data.requestId,
          sessionId: data.sessionId,
          success: false,
          error: payload.error ?? `ACP process stopped during initialization: ${payload.reason}`,
        });
      };

      socket.on('acp:initialized', onInitialized);
      socket.on('acp:stopped', onStopped);

      bridge.start();
    } catch (error) {
      socket.emit('acp:start:result', {
        requestId: data.requestId,
        sessionId: data.sessionId,
        success: false,
        error: (error as Error).message,
      });
    }
  });

  socket.on('acp:message', (data: AcpMessagePayload) => {
    console.log(`ACP message for session ${data.sessionId}`);
    const bridge = acpBridges.get(data.sessionId);
    if (bridge) {
      bridge.sendInput(data.message);
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
