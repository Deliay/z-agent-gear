import { Server as SocketIOServer, type Socket } from 'socket.io';
import bcrypt from 'bcryptjs';
import { ControllerKey } from '../models/controller-key.js';
import { Controller } from '../models/controller.js';
import { sessionService } from './session.js';
import { lookupKey } from './key-cache.js';

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
      await sessionService.refreshSession(socket.data.keyId);
      await sessionService.updateHeartbeat(socket.data.keyId);

      await Controller.updateOne(
        { keyId: socket.data.keyId },
        { lastHeartbeatAt: new Date(), lastIp: socket.data.lastIp },
      );
    });

    socket.on('unregister', async (payload: { reason: string }) => {
      if (!authenticated || !socket.data.keyId) return;

      const { keyId } = socket.data;

      await Controller.deleteOne({ keyId });
      await ControllerKey.deleteOne({ _id: keyId });
      await sessionService.cleanupKey(keyId);

      socket.emit('unregistered');
      socket.disconnect(true);
    });

    socket.on('disconnect', async () => {
      if (socket.data.keyId) {
        await sessionService.removeSession(socket.data.keyId);
      }
    });
  });
}
