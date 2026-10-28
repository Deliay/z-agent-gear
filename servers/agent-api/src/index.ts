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
import { internalCloudHostRouter } from './routes/internal-cloud-host.js';
import { eventCallbackRouter } from './routes/event-callback.js';
import { githubWebhookRouter } from './routes/github-webhook.js';
import { runMigrations } from './migrations/runner.js';
import * as migration001 from './migrations/001-unify-content-format.js';
import * as migration002 from './migrations/002-rename-portforward-to-gateway.js';
import * as migration003 from './migrations/003-mcp-server-registry-fields.js';
import * as migration004 from './migrations/004-provider-scope-name-index.js';
import * as migration005 from './migrations/005-cloud-host-active-unique-index.js';
import * as migration006 from './migrations/006-todo-elicitation-request-id-index.js';
import * as migration007 from './migrations/007-workflow-pr-handler-index.js';
import * as migration008 from './migrations/008-workflow-pr-handler-lower-id.js';
import * as migration009 from './migrations/009-todo-harness-login.js';
import * as migration010 from './migrations/010-issues-linkage-indexes.js';
import * as migration011CloudHostActiveUniqueIndexDrop from './migrations/011-drop-cloud-host-active-unique-index.js';
import * as migration011UserCommitSettingsIndex from './migrations/011-user-commit-settings-index.js';
import * as migration012AccountUserTenant from './migrations/012-account-user-tenant.js';
import * as migration013TenantIdBackfill from './migrations/013-tenant-id-backfill.js';
import * as migration014TenantIdRebackfill from './migrations/014-tenant-id-rebackfill.js';
import { internalUsersRouter } from './routes/internal-users.js';
import { scheduleTenantSelfCheck } from './services/tenant-self-check.js';
import { permissionSubscriberService } from './services/permission-subscriber.js';
import { elicitationSubscriberService } from './services/elicitation-subscriber.js';
import { harnessLoginSubscriberService } from './services/harness-login-subscriber.js';
import { mcpEndpointRevokeSubscriber } from './services/mcp-endpoint-subscriber.js';
import { mcpRelayConsumer } from './services/mcp-relay-consumer.js';
import { sessionLifecycleSubscriber } from './services/session-lifecycle-subscriber.js';
import { workflowOrchestrator } from './services/workflow/orchestrator.js';
import { prHandlerRegistry } from './services/workflow/pr-handler-registry.js';
import { issuesTriggerRunner } from './services/workflow/issues-event-handler.js';
import { registerPrCheckRunSyncHooks } from './services/workflow/pr-check-run-sync.js';
import { prCheckRunSubscriber } from './services/workflow/pr-check-run-subscriber.js';
import { seedBuiltinWorkflowTemplate } from './services/workflow/seed.js';

const app = express();

app.use(cors({ origin: config.corsOrigin }));
app.use(compressionMiddleware());
app.use(cookieParser());
// 事件回调需读取原始报文验签：必须在全局 express.json() 之前挂载
app.use('/api', eventCallbackRouter);
app.use('/api', githubWebhookRouter);
app.use(express.json());

const schema = makeExecutableSchema({ typeDefs, resolvers });

const yoga = createYoga({
  schema,
  context: async ({ request }) => {
    const currentUser = await authenticateUser(request);
    return { currentUser, tenantId: currentUser?.tenantId ?? null };
  },
  graphiql: true,
});

app.use('/graphql', yoga);

app.use('/api', sessionStreamRouter);
app.use('/api', gatewayProxyRouter);
app.use('/api', githubRouter);
app.use('/internal/cloud-hosts', internalCloudHostRouter);
app.use('/internal/users', internalUsersRouter);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

async function start() {
  // 注册工作流引擎 hook（节点会话编排）与会话结束兜底回调
  workflowOrchestrator.register();
  // 工作流完成时注销 PR 联动登记
  prHandlerRegistry.registerPrHandlerLifecycleHooks();
  // 节点状态变化投影到 GitHub Check Runs（先于注销 hook 触发）
  registerPrCheckRunSyncHooks();

  try {
    await mongoose.connect(config.mongodbUri);
    console.log('Connected to MongoDB');
    // 幂等 upsert 内置「开发工作流」模板
    await seedBuiltinWorkflowTemplate();
    // 重建 PR 联动进程内索引（失败只告警，不阻断启动）
    const rebuilt = await prHandlerRegistry.rebuild();
    console.log(`PR handler registry rebuilt: ${rebuilt}`);
  } catch (err) {
    console.warn('MongoDB not available, starting without database:', (err as Error).message);
  }

  try {
    await runMigrations([
      migration001,
      migration002,
      migration003,
      migration004,
      migration005,
      migration006,
      migration007,
      migration008,
      migration009,
      migration010,
      migration011CloudHostActiveUniqueIndexDrop,
      migration011UserCommitSettingsIndex,
      migration012AccountUserTenant,
      migration013TenantIdBackfill,
      migration014TenantIdRebackfill,
    ]);
  } catch (err) {
    console.warn('[Migration] Runner failed:', (err as Error).message);
  }

  // Issues 联动触发状态机：启动扫描 + 1s 定时（Redis 不可用也照常运行）
  issuesTriggerRunner.start();

  try {
    getRedisClient();
    console.log('Connected to Redis');
    
    // Start permission subscriber
    permissionSubscriberService.start();
    console.log('Permission subscriber started');

    // Start elicitation subscriber
    elicitationSubscriberService.start();
    console.log('Elicitation subscriber started');

    // Start harness login subscriber (Kimi Code login guidance)
    harnessLoginSubscriberService.start();
    console.log('Harness login subscriber started');

    // Revoke session MCP endpoints when sessions reach a terminal status
    mcpEndpointRevokeSubscriber.start();
    console.log('MCP endpoint revoke subscriber started');

    // Consume MCP requests bridged from controller-api over Redis
    mcpRelayConsumer.start();
    console.log('MCP relay consumer started');

    // Workflow session lifecycle events (removed / prompt-completed idling)
    sessionLifecycleSubscriber.start();
    console.log('Session lifecycle subscriber started');

    // Workflow todo panel → check-run 子项同步
    prCheckRunSubscriber.start();
    console.log('PR check-run subscriber started');
  } catch (err) {
    console.warn('Redis not available:', (err as Error).message);
  }

  app.listen(config.port, () => {
    console.log(`Agent Gear API running at http://localhost:${config.port}/graphql`);
    // 多租户一期：启动后轻量异步自检（不阻塞对外服务，异常仅告警）
    scheduleTenantSelfCheck();
  });
}

start();
