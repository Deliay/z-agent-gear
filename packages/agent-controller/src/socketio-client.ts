import { io as createSocketIOClient, type Socket } from 'socket.io-client';
import { hostname } from 'os';
import { Heartbeat } from './heartbeat.js';
import { clearConfigKey, saveKeyToConfig, saveEndpointToConfig } from './config.js';

const CONTROLLER_VERSION = '1.0.0';

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
