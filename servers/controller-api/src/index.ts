import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import mongoose from 'mongoose';
import { config } from './config/index.js';
import { getRedisClient, closeRedis } from './middleware/redis.js';
import { createSocketIOServer } from './services/socketio.js';
import { heartbeatService } from './services/heartbeat.js';
import { commandService } from './services/command.js';
import { sessionCommandService } from './services/session-command.js';
import { folderBrowserService } from './services/folder-browser.js';
import { Session } from './models/session.js';

const app = express();
const httpServer = createServer(app);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

const io = new SocketIOServer(httpServer, {
  cors: { origin: '*' },
  transports: ['websocket'],
});

createSocketIOServer(io);

async function start() {
  try {
    await mongoose.connect(config.mongodbUri);
    console.log('Connected to MongoDB');

    // Clean up orphan sessions (stuck in 'connecting' from previous lifecycle)
    await Session.updateMany(
      { status: 'connecting' },
      { status: 'ended', endedAt: new Date() },
    );
  } catch (err) {
    console.warn('MongoDB not available, starting without database:', (err as Error).message);
  }

  getRedisClient();
  console.log('Connected to Redis');

  heartbeatService.start(io);
  commandService.start(io);
  sessionCommandService.start(io);
  folderBrowserService.start(io);

  httpServer.listen(config.port, () => {
    console.log(`Controller API running at http://localhost:${config.port}`);
  });
}

async function gracefulShutdown() {
  console.log('Shutting down...');
  heartbeatService.stop();
  io.close();
  await closeRedis();
  await mongoose.disconnect();
  process.exit(0);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

start();
