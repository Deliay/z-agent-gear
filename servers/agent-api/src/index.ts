import './observability/register.js';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { createYoga } from 'graphql-yoga';
import { GraphQLError } from 'graphql';
import { makeExecutableSchema } from '@graphql-tools/schema';
import mongoose from 'mongoose';
import { config } from './config/index.js';
import { logger as rootLogger } from './observability/logger.js';
import { httpContext } from './observability/http-context.js';
import { typeDefs } from './graphql/schemas/index.js';
import { resolvers } from './graphql/resolvers/index.js';
import { authenticateUser, resolveWorkspaceAccess } from './middleware/auth.js';
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
import * as migration015TeamWorkspaces from './migrations/015-team-workspaces.js';
import * as migration016GithubInstallationGithubUserId from './migrations/016-github-installation-github-user-id.js';
import * as migration017NormalizeStringWorkspaceId from './migrations/017-normalize-string-workspace-id.js';
import * as migration018DropLegacyUniqueIndexes from './migrations/018-drop-legacy-tenantless-unique-indexes.js';
import * as migration019CommitSettingsPerMember from './migrations/019-commit-settings-per-member.js';
import { internalUsersRouter } from './routes/internal-users.js';
import { internalTenantsRouter } from './routes/internal-tenants.js';
import { enterWithWorkspace, getRequestAuth, runWithRequestAuth } from './services/workspace-context.js';
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

const logger = rootLogger.child({ component: 'agent-api' });

app.use(cors({ origin: config.corsOrigin }));
// HTTP 请求上下文（requestId/traceparent/SERVER span/访问日志）：挂在 cors 之后、
// webhook/事件回调路由之前（F10：webhook 需在 express.json() 前验签，httpContext 只读 header）。
app.use(httpContext());
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
    const requestAuth = getRequestAuth();
    if (requestAuth) {
      if (requestAuth.error) {
        throw new GraphQLError(requestAuth.error.message);
      }
      enterWithWorkspace(requestAuth.workspace);
      return {
        currentUser: requestAuth.user,
        tenantId: requestAuth.user?.tenantId ?? null,
        workspaceAccess: requestAuth.workspace ?? null,
      };
    }
    // 兜底（直接调用 yoga handler 的非 Express 场景，如单测）
    const currentUser = await authenticateUser(request);
    if (!currentUser) {
      enterWithWorkspace(undefined);
      return { currentUser: null, tenantId: null };
    }
    const workspace = await resolveWorkspaceAccess(request, currentUser);
    enterWithWorkspace(workspace);
    return { currentUser, tenantId: currentUser.tenantId, workspaceAccess: workspace ?? null };
  },
  graphiql: true,
});

/**
 * 多租户二期：请求级鉴权 + 工作区上下文必须包裹整个下游执行链（Yoga resolver 在
 * context 工厂之后的新异步资源中执行，单独 `enterWith` 无法可靠传播到 Mongoose 插件）。
 */
app.use('/graphql', async (req, res, next) => {
  const headers = new Headers();
  const authorization = req.headers.authorization;
  if (typeof authorization === 'string') headers.set('authorization', authorization);
  const workspaceHeader = req.headers['x-workspace-id'];
  if (typeof workspaceHeader === 'string' && workspaceHeader) {
    headers.set('x-workspace-id', workspaceHeader);
  }
  const webRequest = new Request('http://localhost/graphql', { method: 'POST', headers });
  let currentUser = null;
  try {
    currentUser = await authenticateUser(webRequest);
  } catch {
    currentUser = null;
  }
  if (!currentUser) {
    runWithRequestAuth({ user: null, workspace: undefined }, () => next());
    return;
  }
  try {
    const workspace = await resolveWorkspaceAccess(webRequest, currentUser);
    runWithRequestAuth({ user: currentUser, workspace }, () => next());
  } catch (err) {
    runWithRequestAuth(
      { user: currentUser, workspace: undefined, error: err as Error },
      () => next(),
    );
  }
});

app.use('/graphql', yoga);

app.use('/api', sessionStreamRouter);
app.use('/api', gatewayProxyRouter);
app.use('/api', githubRouter);
app.use('/internal/cloud-hosts', internalCloudHostRouter);
app.use('/internal/users', internalUsersRouter);
app.use('/internal/tenants', internalTenantsRouter);

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
    logger.info({}, 'connected to MongoDB');
    // 幂等 upsert 内置「开发工作流」模板
    await seedBuiltinWorkflowTemplate();
    // 重建 PR 联动进程内索引（失败只告警，不阻断启动）
    const rebuilt = await prHandlerRegistry.rebuild();
    logger.info({ component: 'workflow', rebuilt }, 'PR handler registry rebuilt');
  } catch (err) {
    logger.warn({ err }, 'MongoDB not available, starting without database');
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
      migration015TeamWorkspaces,
      migration016GithubInstallationGithubUserId,
      migration017NormalizeStringWorkspaceId,
      migration018DropLegacyUniqueIndexes,
      migration019CommitSettingsPerMember,
    ]);
  } catch (err) {
    logger.warn({ component: 'migration', err }, 'migration runner failed');
  }

  // Issues 联动触发状态机：启动扫描 + 1s 定时（Redis 不可用也照常运行）
  issuesTriggerRunner.start();

  try {
    getRedisClient();
    logger.info({}, 'connected to Redis');

    // Start permission subscriber
    permissionSubscriberService.start();
    logger.info({ component: 'permission-subscriber' }, 'permission subscriber started');

    // Start elicitation subscriber
    elicitationSubscriberService.start();
    logger.info({ component: 'elicitation-subscriber' }, 'elicitation subscriber started');

    // Start harness login subscriber (Kimi Code login guidance)
    harnessLoginSubscriberService.start();
    logger.info({ component: 'harness-login-subscriber' }, 'harness login subscriber started');

    // Revoke session MCP endpoints when sessions reach a terminal status
    mcpEndpointRevokeSubscriber.start();
    logger.info({ component: 'mcp-endpoint-subscriber' }, 'MCP endpoint revoke subscriber started');

    // Consume MCP requests bridged from controller-api over Redis
    mcpRelayConsumer.start();
    logger.info({ component: 'mcp-relay-consumer' }, 'MCP relay consumer started');

    // Workflow session lifecycle events (removed / prompt-completed idling)
    sessionLifecycleSubscriber.start();
    logger.info({ component: 'session-lifecycle-subscriber' }, 'session lifecycle subscriber started');

    // Workflow todo panel → check-run 子项同步
    prCheckRunSubscriber.start();
    logger.info({ component: 'pr-check-run-subscriber' }, 'PR check-run subscriber started');
  } catch (err) {
    logger.warn({ err }, 'Redis not available');
  }

  app.listen(config.port, () => {
    logger.info({ port: config.port }, 'Agent Gear API running');
    // 多租户一期：启动后轻量异步自检（不阻塞对外服务，异常仅告警）
    scheduleTenantSelfCheck();
  });
}

start();
