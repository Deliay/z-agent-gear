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
import * as migration002 from './migrations/002-refresh-docker-preset-script.js';

const app = express();

// 生产环境未显式配置 CORS_ORIGIN 时 config.corsOrigin 为空串：origin:false 仅允许同源，不再默认放开 `*`
app.use(cors({ origin: config.corsOrigin || false }));
app.use(express.json());

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
  // 002 在 001 之后执行：把未定制过的「Docker」预制脚本刷新为自包含 v2（工作负载四期）
  try {
    await runMigrations([migration001, migration002]);
  } catch (err) {
    console.error('[admin-api] runMigrations failed (non-fatal):', err);
  }

  // 管理员种子失败必须让启动失败：否则服务「健康」但无法登录，且不会再补种
  await seedAdmin();
  console.log('Admin seed ensured');

  app.listen(config.port, () => {
    console.log(`Admin API running at http://localhost:${config.port}/graphql`);
  });
}

start().catch((err) => {
  console.error('[admin-api] Failed to start:', err);
  process.exit(1);
});
