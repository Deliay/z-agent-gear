import express from 'express';
import { env } from './config/index.js';
import { createMcpRouter } from './routes/mcp.js';

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/mcp', createMcpRouter());

async function start() {
  app.listen(env.port, () => {
    console.log(`MCP Forwarder listening on port ${env.port}`);
  });
}

start().catch((e) => {
  console.error(e);
  process.exit(1);
});
