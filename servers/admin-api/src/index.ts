import express from 'express';
import cors from 'cors';
import { createYoga } from 'graphql-yoga';
import { makeExecutableSchema } from '@graphql-tools/schema';
import mongoose from 'mongoose';
import { config } from './config/index.js';
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

async function start() {
  // 管理员 JWT 密钥必须显式配置，缺失时启动即失败（不静默降级）
  if (!process.env.ADMIN_JWT_SECRET) {
    throw new Error('ADMIN_JWT_SECRET is not configured');
  }

  try {
    await mongoose.connect(config.mongodbUri);
    console.log('Connected to MongoDB');
    // 幂等初始化默认管理员
    await seedAdmin();
  } catch (err) {
    console.warn('MongoDB not available, starting without database:', (err as Error).message);
  }

  app.listen(config.port, () => {
    console.log(`Admin API running at http://localhost:${config.port}/graphql`);
  });
}

start().catch((err) => {
  console.error('[admin-api] Failed to start:', err);
  process.exit(1);
});
