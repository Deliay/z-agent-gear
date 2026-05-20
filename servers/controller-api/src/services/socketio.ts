import { Server as SocketIOServer, type Socket } from 'socket.io';
import bcrypt from 'bcryptjs';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { ControllerKey } from '../models/controller-key.js';
import { Controller } from '../models/controller.js';
import { sessionService } from './session.js';
import { lookupKey } from './key-cache.js';
import { acpSessionManager } from './acp-session-manager.js';
import { acpCapabilityDetector } from './acp-capability-detector.js';
import { folderBrowserService } from './folder-browser.js';

const CURRENT_MAJOR_VERSION = '1';

interface RegisterPayload {
  key: string;
  hostname: string;
  version: string;
}

export function createSocketIOServer(io: SocketIOServer): void {
  io.on('connection', (socket: Socket) => {
    let authenticated = false;

    socket.on('register', async (payload: RegisterPayload) => {
      try {
        const { key, hostname, version } = payload;

        const cached = await lookupKey(key);
        if (!cached) {
          socket.emit('error', { code: 'INVALID_KEY', message: 'Key not found' });
          socket.disconnect(true);
          return;
        }

        const { keyId, keyHash, userId, type: keyType } = cached;

        const valid = await bcrypt.compare(key, keyHash);
        if (!valid) {
          socket.emit('error', { code: 'INVALID_KEY', message: 'Invalid key' });
          socket.disconnect(true);
          return;
        }

        const clientMajor = version?.split('.')[0];
        if (clientMajor !== CURRENT_MAJOR_VERSION) {
          socket.emit('error', { code: 'VERSION_MISMATCH', message: 'Version mismatch' });
          socket.disconnect(true);
          return;
        }

        const acquired = await sessionService.acquireSession(keyId, socket.id);
        if (!acquired) {
          socket.emit('error', { code: 'KEY_ALREADY_ONLINE', message: 'Key already has an active session' });
          socket.disconnect(true);
          return;
        }

        const controller = await Controller.findOneAndUpdate(
          { keyId },
          {
            userId,
            hostname,
            type: keyType,
            status: 'online',
            keyId,
            version,
            lastIp: socket.handshake.address,
            lastHeartbeatAt: new Date(),
            name: hostname,
          },
          { upsert: true, new: true },
        );

        await ControllerKey.updateOne(
          { _id: keyId },
          { boundControllerId: controller._id, lastUsedAt: new Date() },
        );

        authenticated = true;
        socket.data.keyId = keyId;
        socket.data.userId = userId;
        socket.data.lastIp = socket.handshake.address;
        socket.join(`user:${userId}`);

        socket.emit('registered', { controllerId: controller._id.toString() });
      } catch (err) {
        console.error('Register error:', err);
        socket.emit('error', { code: 'INVALID_KEY', message: 'Registration failed' });
        socket.disconnect(true);
      }
    });

    socket.on('heartbeat', async () => {
      if (!authenticated || !socket.data.keyId) return;
      try {
        await sessionService.refreshSession(socket.data.keyId);
        await sessionService.updateHeartbeat(socket.data.keyId);

        await Controller.updateOne(
          { keyId: socket.data.keyId },
          { lastHeartbeatAt: new Date(), lastIp: socket.data.lastIp },
        );
      } catch (err) {
        console.error('Heartbeat error:', err);
      }
    });

    socket.on('unregister', async (payload: { reason: string }) => {
      if (!authenticated || !socket.data.keyId) return;

      try {
        const { keyId } = socket.data;

        await Controller.deleteOne({ keyId });
        await ControllerKey.deleteOne({ _id: keyId });
        await sessionService.cleanupKey(keyId);

        socket.emit('unregistered');
        socket.disconnect(true);
      } catch (err) {
        console.error('Unregister error:', err);
      }
    });

    // ACP events
    socket.on('acp:check:result', async (payload: { requestId: string; servers: Array<{ type: string; available: boolean; version?: string }> }) => {
      if (!authenticated) return;
      acpCapabilityDetector.handleCheckResult(payload.requestId, payload.servers);
    });

    socket.on('acp:start:result', async (payload: {
      requestId: string;
      sessionId: string;
      success: boolean;
      error?: string;
      externalSessionId?: string;
    }) => {
      if (!authenticated) return;
      // This is handled by the acpSessionManager through promise resolution
    });

    socket.on('acp:message', async (payload: { sessionId: string; message: Record<string, unknown> }) => {
      if (!authenticated) return;
      try {
        await acpSessionManager.handleControllerMessage(payload.sessionId, payload.message as SessionUpdate);
      } catch (err) {
        console.error(`ACP message error for session ${payload.sessionId}:`, err);
      }
    });

    socket.on('acp:stopped', async (payload: { sessionId: string; reason: string; exitCode?: number }) => {
      if (!authenticated) return;
      try {
        await acpSessionManager.handleControllerStopped(payload.sessionId, payload.reason, payload.exitCode);
      } catch (err) {
        console.error(`ACP stopped error for session ${payload.sessionId}:`, err);
      }
    });

    // File system events
    socket.on('fs:browse:result', async (payload: { requestId: string; entries: Array<{ name: string; path: string; isDirectory: boolean }> }) => {
      if (!authenticated) return;
      await folderBrowserService.handleBrowseResult(payload.requestId, payload.entries);
    });

    socket.on('fs:home:result', async (payload: { requestId: string; path: string }) => {
      if (!authenticated) return;
      await folderBrowserService.handleHomeResult(payload.requestId, payload.path);
    });

    socket.on('disconnect', async () => {
      try {
        if (socket.data.keyId) {
          await sessionService.removeSession(socket.data.keyId);
        }
        await acpSessionManager.handleSocketDisconnect(socket.id);
      } catch (err) {
        console.error('Disconnect error:', err);
      }
    });
  });
}
