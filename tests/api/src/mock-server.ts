import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const FAKE_MODELS = [
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-4-turbo',
  'gpt-4',
  'gpt-3.5-turbo',
];

function handleRequest(req: IncomingMessage, res: ServerResponse, models: string[]) {
  const url = req.url ?? '';

  // OpenAI: GET /v1/models or GET /models（Anthropic 也走同一路径；旧 x-api-key 分支永远不可达，已清理）
  if ((url === '/v1/models' || url === '/models') && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        object: 'list',
        data: models.map((id) => ({
          id,
          object: 'model',
          created: 1715368187,
          owned_by: 'openai',
        })),
      }),
    );
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

export interface MockServer {
  port: number;
  close: () => Promise<void>;
}

export function startMockServer(models: string[] = FAKE_MODELS): Promise<MockServer> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => handleRequest(req, res, models));
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        port,
        close: () =>
          new Promise<void>((resolveClose) => {
            server.close(() => resolveClose());
          }),
      });
    });
  });
}
