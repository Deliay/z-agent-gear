import express from 'express';
import cors from 'cors';
import { createYoga } from 'graphql-yoga';
import { makeExecutableSchema } from '@graphql-tools/schema';
import mongoose from 'mongoose';
import { config, assertRuntimeConfig } from './config/index.js';
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
import { CloudHost } from './models/cloud-host.js';

const app = express();

// 生产环境未显式配置 CORS_ORIGIN 时 config.corsOrigin 为空串：origin:false 仅允许同源，不再默认放开 `*`
app.use(cors({ origin: config.corsOrigin || false }));
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
  console,
  config.outboxRelayIntervalMs,
);
app.use('/v1', createBillingOpenAiRouter({ publisher: outboxPublisher }));
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
      console.log('Connected to MongoDB');
      return;
    } catch (err) {
      lastError = err;
      console.warn(`[admin-api] MongoDB connect attempt ${attempt}/${attempts} failed:`, (err as Error).message);
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
    ]);
  } catch (err) {
    console.error('[admin-api] runMigrations failed (non-fatal):', err);
  }

  // 管理员种子失败必须让启动失败：否则服务「健康」但无法登录，且不会再补种
  await seedAdmin();
  console.log('Admin seed ensured');

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
    console.warn('[admin-api] billing syncIndexes failed (non-fatal):', (err as Error).message);
  }
  // 只读模型（cloudhosts 归 agent-api 所有）：只补建声明索引，绝不使用 syncIndexes——
  // syncIndexes 会删除 schema 未声明的索引，误删 agent-api 的所有索引。
  try {
    await CloudHost.createIndexes();
  } catch (err) {
    console.warn('[admin-api] cloudhosts createIndexes failed (non-fatal):', (err as Error).message);
  }
  try {
    await pricingService.ensureDefaultPrices();
  } catch (err) {
    console.warn('[admin-api] ensureDefaultPrices failed (non-fatal):', (err as Error).message);
  }

  // MQ 消费/调度失败不阻断 API 启动（计费事件由 outbox 保留，恢复后补投；运行时自动重连）。
  // 首次连接有界：AMQP 握手超时（默认 10s，见 MqConnection）后转入后台退避重连，
  // 代理接受 TCP 但握手卡死的场景不再永久阻塞 listen。
  const mqRuntime = new BillingMqRuntime({
    url: config.rabbitmqUrl,
    billing: billingRuntime,
    ingest: eventIngestService,
    logger: console,
  });
  await mqRuntime.start();

  const scheduler = new BillingScheduler({
    publisher: outboxPublisher,
    settlementTick: new SettlementTickService(billingRuntime, reservationService, {
      // A-3：stale 终结前复核控制面存活，活容器只补结算不置 SETTLED。
      isAlive: isCloudContainerAlive,
    }),
    reconciliation: reconciliationRuntime,
    logger: console,
  });
  scheduler.start();

  const server = app.listen(config.port, () => {
    console.log(`Admin API running at http://localhost:${config.port}/graphql`);
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[admin-api] ${signal} received, shutting down...`);
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
  console.error('[admin-api] Failed to start:', err);
  process.exit(1);
});
