import { Server as SocketIOServer, type Socket } from 'socket.io';
import bcrypt from 'bcryptjs';
import { ControllerKey } from '../models/controller-key.js';
import { Controller } from '../models/controller.js';
import { sessionService } from './session.js';

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

        const keyDoc = await ControllerKey.findOne({ status: { $ne: 'revoked' } }).lean();
        if (!keyDoc) {
          socket.emit('error', { code: 'INVALID_KEY', message: 'Key not found' });
          socket.disconnect(true);
          return;
        }

        const valid = await bcrypt.compare(key, keyDoc.keyHash);
        if (!valid) {
          socket.emit('error', { code: 'INVALID_KEY', message: 'Invalid key' });
          socket.disconnect(true);
          return;
        }

        if (keyDoc.status === 'revoked') {
          socket.emit('error', { code: 'KEY_REVOKED', message: 'Key has been revoked' });
          socket.disconnect(true);
          return;
        }

        if (keyDoc.status === 'expired') {
          socket.emit('error', { code: 'KEY_EXPIRED', message: 'Key has expired' });
          socket.disconnect(true);
          return;
        }

        const clientMajor = version?.split('.')[0];
        if (clientMajor !== CURRENT_MAJOR_VERSION) {
          socket.emit('error', { code: 'VERSION_MISMATCH', message: 'Version mismatch' });
          socket.disconnect(true);
          return;
        }

        const keyId = (keyDoc._id as unknown as string).toString();
        const acquired = await sessionService.acquireSession(keyId, socket.id);
        if (!acquired) {
          socket.emit('error', { code: 'KEY_ALREADY_ONLINE', message: 'Key already has an active session' });
          socket.disconnect(true);
          return;
        }

        const controller = await Controller.findOneAndUpdate(
          { keyId: keyDoc._id },
          {
            userId: keyDoc.userId,
            hostname,
            type: keyDoc.type,
            status: 'online',
            keyId: keyDoc._id,
            version,
            lastIp: socket.handshake.address,
            lastHeartbeatAt: new Date(),
            name: hostname,
          },
          { upsert: true, new: true },
        );

        await ControllerKey.updateOne(
          { _id: keyDoc._id },
          { boundControllerId: controller._id, lastUsedAt: new Date() },
        );

        authenticated = true;
        socket.data.keyId = keyId;
        socket.data.userId = keyDoc.userId.toString();
        socket.data.lastIp = socket.handshake.address;
        socket.join(`user:${keyDoc.userId}`);

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

      const { keyId, userId } = socket.data;

      await Controller.updateOne({ keyId }, { status: 'unbound' });
      await ControllerKey.updateOne({ _id: keyId }, { boundControllerId: null });
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
