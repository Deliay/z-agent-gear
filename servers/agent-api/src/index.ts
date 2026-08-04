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

const app = express();

app.use(cors({ origin: config.corsOrigin }));
app.use(compressionMiddleware());
app.use(cookieParser());

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
  try {
    await mongoose.connect(config.mongodbUri);
    console.log('Connected to MongoDB');
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
  } catch (err) {
    console.warn('Redis not available:', (err as Error).message);
  }

  app.listen(config.port, () => {
    console.log(`Agent Gear API running at http://localhost:${config.port}/graphql`);
  });
}

start();
