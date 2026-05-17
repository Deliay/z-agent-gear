import express from 'express';
import cors from 'cors';
import { createYoga } from 'graphql-yoga';
import { makeExecutableSchema } from '@graphql-tools/schema';
import mongoose from 'mongoose';
import { config } from './config/index.js';
import { typeDefs } from './graphql/schemas/index.js';
import { resolvers } from './graphql/resolvers/index.js';
import { authenticateUser } from './middleware/auth.js';

const app = express();

app.use(cors());

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

  app.listen(config.port, () => {
    console.log(`Agent Gear API running at http://localhost:${config.port}/graphql`);
  });
}

start();
