import './observability/register.js';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import mongoose from 'mongoose';
import { logger as rootLogger } from './observability/logger.js';
import { httpContext } from './observability/http-context.js';
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
import { elicitationManager } from './services/elicitation-manager.js';
import { harnessLoginManager } from './services/harness-login-manager.js';
import { DisconnectTimer } from './services/disconnect-timer.js';
import { Session } from './models/session.js';
import { createMcpProxyKeyRouter } from './routes/mcp-proxy-key.js';
import { createMcpProxyRouter } from './routes/mcp-proxy.js';
import { McpProxyRegistry } from './services/mcp-proxy-registry.js';
import { McpForwardConsumer } from './services/mcp-forward-consumer.js';

const logger = rootLogger.child({ component: 'controller-api' });

const app = express();
const httpServer = createServer(app);

app.use(cors());
app.use(httpContext());
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

const io = new SocketIOServer(httpServer, {
  cors: { origin: '*' },
  transports: ['websocket'],
  maxHttpBufferSize: 16 * 1024 * 1024,
});

const mcpProxyRegistry = new McpProxyRegistry(io);
mcpProxyRegistry.setupNamespace();
const mcpForwardConsumer = new McpForwardConsumer(mcpProxyRegistry);

app.use('/api/mcp-proxy-keys', createMcpProxyKeyRouter());
app.use('/api/mcp-proxy', createMcpProxyRouter(mcpProxyRegistry));

createSocketIOServer(io);

const disconnectTimer = new DisconnectTimer();

async function start() {
  try {
    await mongoose.connect(config.mongodbUri);
    logger.info('connected to MongoDB');

    // Clean up orphan sessions (stuck in 'connecting' from previous lifecycle)
    await Session.updateMany(
      { status: 'connecting' },
      { status: 'ended', endedAt: new Date() },
    );
  } catch (err) {
    logger.warn({ err }, 'MongoDB not available, starting without database');
  }

  getRedisClient();
  logger.info('connected to Redis');

  mcpForwardConsumer.start();

  heartbeatService.start(io);
  commandService.start(io);
  sessionCommandService.start(io);
  folderBrowserService.start(io);
  gitBrowserService.start(io);
  worktreeService.start(io);
  fsMkdirService.start(io);
  gatewayRelayService.start(io);
  permissionManager.start(io);
  elicitationManager.start(io);
  harnessLoginManager.start(io);

  disconnectTimer.start();

  httpServer.listen(config.port, () => {
    logger.info({ port: config.port }, 'controller API listening');
  });
}

async function gracefulShutdown() {
  logger.info('shutting down');
  heartbeatService.stop();
  permissionManager.stop();
  elicitationManager.stop();
  harnessLoginManager.stop();
  disconnectTimer.stop();
  mcpForwardConsumer.stop();
  io.close();
  await closeRedis();
  await mongoose.disconnect();
  process.exit(0);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

start().catch((e) => {
  logger.error({ err: e }, 'controller API failed to start');
  process.exit(1);
});
