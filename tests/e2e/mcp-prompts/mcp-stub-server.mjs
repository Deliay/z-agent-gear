// 最小复现用 MCP 服务桩（Streamable HTTP 形态，零依赖）。
//
// 两个变体：
//   MCP_VARIANT=prompts   → initialize 声明 capabilities.prompts，提供 prompts/list、prompts/get
//   MCP_VARIANT=tools     → initialize 只声明 capabilities.tools（与平台 agent-workflow-tools /
//                           agent-cloud-host-tools / agent-session-preview-tools / agent-valut-tools /
//                           agent-custom-tools 的现状一致）
//
// 所有入站 JSON-RPC 方法逐条写入 MCP_STUB_LOG，供复现脚本断言"harness 到底调用了什么"。
import http from 'node:http';
import fs from 'node:fs';

const LOG = process.env.MCP_STUB_LOG ?? '/tmp/zag-mcp-prompts-repro/stub.log';
const PORT = Number(process.env.MCP_STUB_PORT ?? 7811);
const VARIANT = process.env.MCP_VARIANT ?? 'prompts';
const NAME = process.env.MCP_STUB_NAME ?? `stub-${VARIANT}`;
const PROMPT_TEXT = process.env.MCP_STUB_PROMPT_TEXT ?? 'HELLO FROM MCP PROMPT';

function log(entry) {
  fs.mkdirSync(LOG.replace(/\/[^/]+$/, ''), { recursive: true });
  fs.appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), server: NAME, ...entry }) + '\n');
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      /* ignore */
    }
    log({ event: 'request', httpMethod: req.method, method: body?.method ?? null });
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }
    if (!body || !body.method) {
      res.writeHead(400);
      res.end();
      return;
    }
    const send = (obj) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    const reply = (result) => send({ jsonrpc: '2.0', id: body.id, result });
    // 平台 mcp-dispatch 的真实错误码形态（字符串 code，见报告 §5.4）
    const error = (code, message) => send({ jsonrpc: '2.0', id: body.id, error: { code, message } });

    switch (body.method) {
      case 'initialize':
        return reply({
          protocolVersion: '2025-03-26',
          capabilities: VARIANT === 'prompts' ? { tools: {}, prompts: {} } : { tools: {} },
          serverInfo: { name: NAME, version: '1.0.0' },
        });
      case 'notifications/initialized':
      case 'notifications/cancelled':
        res.writeHead(202);
        res.end();
        return;
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({
          tools: [
            {
              name: `${NAME}_echo`,
              description: 'echo',
              inputSchema: { type: 'object', properties: {} },
            },
          ],
        });
      case 'tools/call':
        return reply({ content: [{ type: 'text', text: 'echo' }] });
      case 'prompts/list':
        if (VARIANT !== 'prompts') return error('METHOD_NOT_FOUND', `不支持的方法：${body.method}`);
        return reply({ prompts: [{ name: 'demo-prompt', description: '用于验证的提示词片段' }] });
      case 'prompts/get':
        if (VARIANT !== 'prompts') return error('METHOD_NOT_FOUND', `不支持的方法：${body.method}`);
        return reply({
          description: '用于验证的提示词片段',
          messages: [{ role: 'user', content: { type: 'text', text: PROMPT_TEXT } }],
        });
      default:
        return error('METHOD_NOT_FOUND', `不支持的方法：${body.method}`);
    }
  });
});

server.listen(PORT, '127.0.0.1', () => log({ event: 'listening', port: PORT }));
