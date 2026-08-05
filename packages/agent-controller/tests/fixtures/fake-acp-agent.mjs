// Fake ACP agent used by acp-wire-mcp.test.ts.
// Speaks ndjson JSON-RPC over stdio: answers initialize/session/new/session/resume
// and records every session/new & session/resume params payload to CAPTURE_FILE
// (one JSON per line) so tests can assert the exact wire format.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const captureFile = process.env.CAPTURE_FILE;

const rl = createInterface({ input: process.stdin });

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined || !msg.method) return; // ignore notifications

  switch (msg.method) {
    case 'initialize':
      reply(msg.id, {
        protocolVersion: 1,
        agentCapabilities: { mcpCapabilities: { http: true, sse: true } },
        agentInfo: { name: 'fake-acp-agent', version: '0.0.1' },
        authMethods: [],
      });
      break;
    case 'session/new':
    case 'session/resume':
      if (captureFile) {
        appendFileSync(captureFile, JSON.stringify({ method: msg.method, params: msg.params }) + '\n');
      }
      reply(msg.id, { sessionId: 'fake-acp-session-1' });
      break;
    default:
      reply(msg.id, {});
  }
});
