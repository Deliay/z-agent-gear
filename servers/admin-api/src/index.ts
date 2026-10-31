import './observability/register.js';
import express from 'express';
import cors from 'cors';
import { createYoga } from 'graphql-yoga';
import { makeExecutableSchema } from '@graphql-tools/schema';
import mongoose from 'mongoose';
import { config, assertRuntimeConfig } from './config/index.js';
import { logger as rootLogger } from './observability/logger.js';
import { httpContext } from './observability/http-context.js';
import { typeDefs } from './graphql/schemas/index.js';
import { resolvers } from './graphql/resolvers/index.js';
import { authenticateAdmin } from './middleware/auth.js';
import { clientIpFrom } from './middleware/client-ip.js';
import { seedAdmin } from './services/auth.js';
import { runMigrations } from './migrations/runner.js';
import * as migration001 from './migrations/001-preset-workloads.js';
import * as migration002DotnetApt from './migrations/002-preset-dotnet-apt.js';
import * as migration002RefreshDocker from './migrations/002-refresh-docker-preset-script.js';
import { createInternalBillingRouter } from './routes/internal-billing.js';
import { createBillingOpenAiRouter } from './routes/billing-openai.js';
import { AdminOutboxPublisher } from './services/billing/mq/publisher.js';
import { SettlementTickService } from './services/billing/settlement-tick.js';
import { BillingScheduler } from './services/billing/scheduler.js';
import { billingRuntime, reconciliationRuntime, isCloudContainerAlive } from './services/billing/instances.js';
import { reservationService } from './services/billing/reservation.js';
import { pricingService } from './services/billing/pricing.js';
import { eventIngestService } from './services/billing/event-ingest.js';
import { BillingMqRuntime } from './services/billing/mq/runtime.js';
import { BillingAccount } from './models/billing-account.js';
import { BillingLedger } from './models/billing-ledger.js';
import { BillingEvent } from './models/billing-event.js';
import { MeteringRecord } from './models/metering-record.js';
import { ProductPrice } from './models/product-price.js';
import { BillingInvoice } from './models/billing-invoice.js';
import { BillingPayment } from './models/billing-payment.js';
import { BillingReceipt } from './models/billing-receipt.js';
import { BillingReservation, BillingReservationCycle } from './models/billing-reservation.js';
import { BillingRollup } from './models/billing-rollup.js';
import { BillingApiKey } from './models/billing-api-key.js';
import { BillingApiCall } from './models/billing-api-call.js';
import { BillingOutbox } from './models/billing-outbox.js';
import { BillingDeadLetter } from './models/billing-dead-letter.js';
import { BillingAppliedLedger } from './models/billing-applied-ledger.js';
import * as migration003DockerAptSource from './migrations/003-docker-apt-source.js';
import * as migration004AspireCliSource from './migrations/004-aspire-cli-source.js';
import * as migration005ModelNameUnique from './migrations/005-model-name-unique-global.js';
import * as migration006HarnessOpencode from './migrations/006-preset-harness-opencode.js';
import * as migration007PresetGithub from './migrations/007-preset-github.js';
import * as migration008FixGithubWorkloadPrefix from './migrations/008-fix-github-workload-prefix.js';
import * as migration009HarnessKimiCode from './migrations/009-preset-harness-kimi-code.js';
import * as migration010PresetHarnessDeepseek from './migrations/010-preset-harness-deepseek.js';
import * as migration012WorkerUserScripts from './migrations/012-worker-user-scripts.js';
import * as migration010ClearCloudHostKeyExpiry from './migrations/010-clear-cloud-host-key-expiry.js';
import * as migration011RefreshHarnessPrepareScope from './migrations/011-refresh-harness-prepare-scope.js';
import * as migration013PresetHarnessDeepseekHeaderMasq from './migrations/013-preset-harness-deepseek-header-masq.js';
import * as migration014BillingOwnerTenant from './migrations/014-billing-owner-tenant.js';
import * as migration015PresetPlaywright from './migrations/015-preset-playwright.js';
import * as migration016PresetMongo from './migrations/016-preset-mongodb.js';
import { CloudHost } from './models/cloud-host.js';

const logger = rootLogger.child({ component: 'admin-api' });

const app = express();

// 生产环境未显式配置 CORS_ORIGIN 时 config.corsOrigin 为空串：origin:false 仅允许同源，不再默认放开 `*`
app.use(cors({ origin: config.corsOrigin || false }));
// 请求级可观测性：requestId 归一化 + traceparent 提取 + SERVER span + 访问日志（契约 §5.2/§5.4）
app.use(httpContext());
// 计费网关会转发较大的请求体（如批量事件），放宽 body 上限至 128MB
app.use(express.json({ limit: '128mb' }));

const schema = makeExecutableSchema({ typeDefs, resolvers });

const yoga = createYoga({
  schema,
  context: async (ctx) => ({
    currentAdmin: await authenticateAdmin(ctx.request),
    // 问题 49/57：默认取底层 socket 对端地址；仅当对端命中 TRUST_PROXY 受信代理列表时才采纳转发头末跳
    clientIp: clientIpFrom(ctx.request, (ctx as { req?: unknown }).req),
  }),
  // 生产环境关闭 GraphiQL 交互式浏览器（问题 26）
  graphiql: config.nodeEnv !== 'production',
});

app.use('/graphql', yoga);

// 费用中心：OpenAI 兼容计费网关（API Key 鉴权）与 agent-api 内部 REST
const outboxPublisher = new AdminOutboxPublisher(
  config.rabbitmqUrl,
  logger.child({ component: 'billing-outbox' }),
  config.outboxRelayIntervalMs,
);
app.use(
  '/v1',
  createBillingOpenAiRouter({
    publisher: outboxPublisher,
    logger: logger.child({ component: 'billing-gateway' }),
  }),
);
app.use('/internal/billing', createInternalBillingRouter());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

/** MongoDB 连接重试：避免 admin-api 先于 Mongo 就绪时直接失败 */
async function connectWithRetry(attempts = 10, delayMs = 2000): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await mongoose.connect(config.mongodbUri);
      logger.info('connected to MongoDB');
      return;
    } catch (err) {
      lastError = err;
      logger.warn({ err, attempt, attempts }, 'MongoDB connect attempt failed');
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

async function start() {
  // 运行期配置校验（ADMIN_JWT_SECRET / CREDENTIAL_ENCRYPTION_KEY），缺失即失败（不静默降级）
  assertRuntimeConfig();

  await connectWithRetry();

  // 一次性预制工作负载（admin_migrations 账本）：失败只记录日志、不阻断启动，下次启动按未完成重试
  // 两个 002 迁移按各自 name 记账、均在 001 之后执行：
  // 002-preset-dotnet-apt——存量 .NET 预制脚本保守升级为 apt 版（三期）；
  // 002-refresh-docker-preset-script——把未定制过的「Docker」预制脚本刷新为自包含 v2（四期）；
  // 003-docker-apt-source——把未定制过的「Docker」脚本刷新为 v3 并补齐 docker_apt_url 参数（本期）
  // 004-aspire-cli-source——把未定制过的「Aspire」脚本刷新为 v2 并补齐 aspire_cli_url 参数（本期）
  // 005-model-name-unique-global——整理 global 存量重名模型并建立 name 部分唯一索引（本期）
  // 006-preset-harness-opencode——写入云电脑 harness 运行环境预置项「OpenCode（Harness）」（云电脑）
  // 007-preset-github——写入 Github 工作负载预置项（安装 gh CLI，Github 工作负载）
  // 009-preset-harness-kimi-code——写入云电脑 harness 运行环境预置项「Kimi Code（Harness）」（Kimi Code 云电脑）
  // 010-preset-harness-deepseek——写入云电脑 harness 运行环境预置项「DeepSeek Harness（Harness）」（DeepSeek 云电脑）
  // 010-clear-cloud-host-key-expiry——清空云电脑运行专用 Key 的固定有效期（改为随容器回收）
  // 011-refresh-harness-prepare-scope——把未定制过的 OpenCode/DeepSeek harness 预置脚本中裸
  //   `agent-gear harness prepare` 刷新为按类型限定（多 harness 主机顺序安装 CLI 时裸调用会误失败）
  // 013-preset-harness-deepseek-header-masq——把未定制过的 DeepSeek harness 预置脚本刷新为 V4
  //   （固定版本 0.2.1-rc.2 + `dsh plugin --profile acp add Deliay/dsh-header-masq` 会话标识插件）
  // 014-billing-owner-tenant——前台计费归属 ownerType front_user→tenant（admin_user 行零改动、金额零改动）
  // 015-preset-playwright——写入 Playwright 预制工作负载（工具 + Chromium，参数化内网下载地址）
  // 016-preset-mongodb——写入 MongoDB 预制工作负载（内网 Nexus apt 原生安装 mongodb-org 8.0；015 已被 Playwright 占用，顺延）
  try {
    await runMigrations([
      migration001,
      migration002DotnetApt,
      migration002RefreshDocker,
      migration003DockerAptSource,
      migration004AspireCliSource,
      migration005ModelNameUnique,
      migration006HarnessOpencode,
      migration007PresetGithub,
      migration008FixGithubWorkloadPrefix,
      migration009HarnessKimiCode,
      migration010PresetHarnessDeepseek,
      migration012WorkerUserScripts,
      migration010ClearCloudHostKeyExpiry,
      migration011RefreshHarnessPrepareScope,
      migration013PresetHarnessDeepseekHeaderMasq,
      migration014BillingOwnerTenant,
      migration015PresetPlaywright,
      migration016PresetMongo,
    ]);
  } catch (err) {
    logger.error({ err }, 'runMigrations failed (non-fatal)');
  }

  // 管理员种子失败必须让启动失败：否则服务「健康」但无法登录，且不会再补种
  await seedAdmin(logger.child({ component: 'auth' }));
  logger.info('admin seed ensured');

  // ===== 费用中心初始化 =====
  const billingModels = [
    BillingAccount,
    BillingLedger,
    BillingEvent,
    MeteringRecord,
    ProductPrice,
    BillingInvoice,
    BillingPayment,
    BillingReceipt,
    BillingReservation,
    BillingReservationCycle,
    BillingRollup,
    BillingApiKey,
    BillingApiCall,
    BillingOutbox,
    BillingDeadLetter,
    BillingAppliedLedger,
  ];
  try {
    await Promise.all(billingModels.map((model) => model.syncIndexes()));
  } catch (err) {
    logger.warn({ err }, 'billing syncIndexes failed (non-fatal)');
  }
  // 只读模型（cloudhosts 归 agent-api 所有）：只补建声明索引，绝不使用 syncIndexes——
  // syncIndexes 会删除 schema 未声明的索引，误删 agent-api 的所有索引。
  try {
    await CloudHost.createIndexes();
  } catch (err) {
    logger.warn({ err }, 'cloudhosts createIndexes failed (non-fatal)');
  }
  try {
    await pricingService.ensureDefaultPrices();
  } catch (err) {
    logger.warn({ err }, 'ensureDefaultPrices failed (non-fatal)');
  }

  // MQ 消费/调度失败不阻断 API 启动（计费事件由 outbox 保留，恢复后补投；运行时自动重连）。
  // 首次连接有界：AMQP 握手超时（默认 10s，见 MqConnection）后转入后台退避重连，
  // 代理接受 TCP 但握手卡死的场景不再永久阻塞 listen。
  const mqRuntime = new BillingMqRuntime({
    url: config.rabbitmqUrl,
    billing: billingRuntime,
    ingest: eventIngestService,
    logger: logger.child({ component: 'billing-mq' }),
  });
  await mqRuntime.start();

  const scheduler = new BillingScheduler({
    publisher: outboxPublisher,
    settlementTick: new SettlementTickService(billingRuntime, reservationService, {
      // A-3：stale 终结前复核控制面存活，活容器只补结算不置 SETTLED。
      isAlive: isCloudContainerAlive,
      logger: logger.child({ component: 'billing-settlement' }),
    }),
    reconciliation: reconciliationRuntime,
    logger: logger.child({ component: 'billing-scheduler' }),
  });
  scheduler.start();

  const server = app.listen(config.port, () => {
    logger.info({ port: config.port, graphqlPath: '/graphql' }, 'Admin API running');
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    server.close();
    await scheduler.stop();
    await mqRuntime.stop();
    await mongoose.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

start().catch((err) => {
  logger.error({ err }, 'failed to start');
  process.exit(1);
});
