// Deterministic mock MCP server over stdio (newline-delimited JSON-RPC).
// Provides one tool `resolve_mock_endpoint` that echoes a fixed marker so
// end-to-end tests can prove the full chain works:
//   agent -> ACP mcpServers -> agent-api /mcp entry -> Redis forward ->
//   controller-api -> mcp-proxy websocket -> this process.
//
// The marker is fixed text (not random) so tests can assert on it reliably.
import { createInterface } from 'node:readline';

const MARKER = process.env.MOCK_MCP_MARKER || 'MCP_TOOL_OK:mock-mcp-passthrough';
const TOOL_NAME = 'resolve_mock_endpoint';

const rl = createInterface({ input: process.stdin });

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

rl.on('line', (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  if (!req || req.id === undefined || req.id === null) return; // notifications: no response

  switch (req.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'mock-mcp-probe', version: '0.0.1' },
        },
      });
      break;
    case 'ping':
      send({ jsonrpc: '2.0', id: req.id, result: {} });
      break;
    case 'tools/list':
      send({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          tools: [{
            name: TOOL_NAME,
            description: 'Resolve a mock endpoint address; returns a fixed marker proving the MCP chain works.',
            inputSchema: {
              type: 'object',
              properties: { address: { type: 'string', description: 'endpoint address to resolve' } },
              required: ['address'],
            },
          }],
        },
      });
      break;
    case 'tools/call':
      if (req.params?.name === TOOL_NAME) {
        const address = req.params?.arguments?.address ?? '(none)';
        send({
          jsonrpc: '2.0',
          id: req.id,
          result: { content: [{ type: 'text', text: `${MARKER} address=${address}` }] },
        });
      } else {
        send({ jsonrpc: '2.0', id: req.id, error: { code: -32602, message: `unknown tool ${req.params?.name}` } });
      }
      break;
    default:
      send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `method not found: ${req.method}` } });
  }
});
