import express from 'express';
import cors from 'cors';
import { createYoga } from 'graphql-yoga';
import { makeExecutableSchema } from '@graphql-tools/schema';
import mongoose from 'mongoose';
import { config, assertRuntimeConfig } from './config/index.js';
import { typeDefs } from './graphql/schemas/index.js';
import { resolvers } from './graphql/resolvers/index.js';
import { authenticateAdmin } from './middleware/auth.js';
import { seedAdmin } from './services/auth.js';

const app = express();

app.use(cors({ origin: config.corsOrigin }));
app.use(express.json());

const schema = makeExecutableSchema({ typeDefs, resolvers });

const yoga = createYoga({
  schema,
  context: async ({ request }) => ({
    currentAdmin: await authenticateAdmin(request),
  }),
  graphiql: true,
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
