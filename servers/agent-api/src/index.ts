import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { createYoga } from 'graphql-yoga';
import { makeExecutableSchema } from '@graphql-tools/schema';
import mongoose from 'mongoose';
import { config } from './config/index.js';
import { typeDefs } from './graphql/schemas/index.js';
import { resolvers } from './graphql/resolvers/index.js';
import { authenticateUser } from './middleware/auth.js';
import { compressionMiddleware } from './middleware/compression.js';
import { getRedisClient } from './middleware/redis.js';
import { sessionStreamRouter } from './routes/session-stream.js';
import { gatewayProxyRouter } from './routes/gateway-proxy.js';
import { githubRouter } from './routes/github.js';
import { runMigrations } from './migrations/runner.js';
import * as migration001 from './migrations/001-unify-content-format.js';
import * as migration002 from './migrations/002-rename-portforward-to-gateway.js';
import * as migration003 from './migrations/003-mcp-server-registry-fields.js';
import { permissionSubscriberService } from './services/permission-subscriber.js';
import { elicitationSubscriberService } from './services/elicitation-subscriber.js';
import { mcpEndpointRevokeSubscriber } from './services/mcp-endpoint-subscriber.js';
import { mcpRelayConsumer } from './services/mcp-relay-consumer.js';
import { sessionLifecycleSubscriber } from './services/session-lifecycle-subscriber.js';
import { workflowOrchestrator } from './services/workflow/orchestrator.js';
import { seedBuiltinWorkflowTemplate } from './services/workflow/seed.js';

const app = express();

app.use(cors({ origin: config.corsOrigin }));
app.use(compressionMiddleware());
app.use(cookieParser());
app.use(express.json());

const schema = makeExecutableSchema({ typeDefs, resolvers });

const yoga = createYoga({
  schema,
  context: async ({ request }) => {
    const currentUser = await authenticateUser(request);
    return { currentUser };
  },
  graphiql: true,
});

app.use('/graphql', yoga);

app.use('/api', sessionStreamRouter);
app.use('/api', gatewayProxyRouter);
app.use('/api', githubRouter);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

async function start() {
  // 注册工作流引擎 hook（节点会话编排）与会话结束兜底回调
  workflowOrchestrator.register();

  try {
    await mongoose.connect(config.mongodbUri);
    console.log('Connected to MongoDB');
    // 幂等 upsert 内置「开发工作流」模板
    await seedBuiltinWorkflowTemplate();
  } catch (err) {
    console.warn('MongoDB not available, starting without database:', (err as Error).message);
  }

  try {
    await runMigrations([migration001, migration002, migration003]);
  } catch (err) {
    console.warn('[Migration] Runner failed:', (err as Error).message);
  }

  try {
    getRedisClient();
    console.log('Connected to Redis');
    
    // Start permission subscriber
    permissionSubscriberService.start();
    console.log('Permission subscriber started');

    // Start elicitation subscriber
    elicitationSubscriberService.start();
    console.log('Elicitation subscriber started');

    // Revoke session MCP endpoints when sessions reach a terminal status
    mcpEndpointRevokeSubscriber.start();
    console.log('MCP endpoint revoke subscriber started');

    // Consume MCP requests bridged from controller-api over Redis
    mcpRelayConsumer.start();
    console.log('MCP relay consumer started');

    // Workflow session lifecycle events (removed / prompt-completed idling)
    sessionLifecycleSubscriber.start();
    console.log('Session lifecycle subscriber started');
  } catch (err) {
    console.warn('Redis not available:', (err as Error).message);
  }

  app.listen(config.port, () => {
    console.log(`Agent Gear API running at http://localhost:${config.port}/graphql`);
  });
}

start();
