import express from 'express';
import cors from 'cors';
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
import { gitBrowserService } from './services/git-browser.js';
import { worktreeService } from './services/worktree-service.js';
import { fsMkdirService } from './services/fs-mkdir-service.js';
import { gatewayRelayService } from './services/gateway-relay.js';
import { permissionManager } from './services/permission-manager.js';
import { DisconnectTimer } from './services/disconnect-timer.js';
import { Session } from './models/session.js';
import { createMcpProxyKeyRouter } from './routes/mcp-proxy-key.js';
import { createMcpProxyRouter } from './routes/mcp-proxy.js';
import { createMcpEndpointRouter } from './routes/mcp-endpoint.js';
import { McpProxyRegistry } from './services/mcp-proxy-registry.js';

const app = express();
const httpServer = createServer(app);

app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

const io = new SocketIOServer(httpServer, {
  cors: { origin: '*' },
  transports: ['websocket'],
});

const mcpProxyRegistry = new McpProxyRegistry(io);
mcpProxyRegistry.setupNamespace();

app.use('/api/mcp-proxy-keys', createMcpProxyKeyRouter());
app.use('/api/mcp-proxy', createMcpProxyRouter(mcpProxyRegistry));
app.use('/api/mcp-endpoints', createMcpEndpointRouter());

createSocketIOServer(io);

const disconnectTimer = new DisconnectTimer();

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
  gitBrowserService.start(io);
  worktreeService.start(io);
  fsMkdirService.start(io);
  gatewayRelayService.start(io);
  permissionManager.start(io);

  disconnectTimer.start();

  httpServer.listen(config.port, () => {
    console.log(`Controller API running at http://localhost:${config.port}`);
  });
}

async function gracefulShutdown() {
  console.log('Shutting down...');
  heartbeatService.stop();
  permissionManager.stop();
  disconnectTimer.stop();
  io.close();
  await closeRedis();
  await mongoose.disconnect();
  process.exit(0);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

start().catch((e) => {
  console.error(e);
  process.exit(1);
});
