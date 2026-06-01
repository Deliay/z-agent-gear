import express from 'express';
import mongoose from 'mongoose';
import { env } from './config/index.js';
import { createMcpRouter } from './routes/mcp.js';

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/mcp', createMcpRouter());

async function start() {
  try {
    await mongoose.connect(env.mongodbUri);
    console.log('Connected to MongoDB');
  } catch (err) {
    console.warn('MongoDB not available:', (err as Error).message);
  }

  app.listen(env.port, () => {
    console.log(`MCP Forwarder listening on port ${env.port}`);
  });
}

start().catch((e) => {
  console.error(e);
  process.exit(1);
});
