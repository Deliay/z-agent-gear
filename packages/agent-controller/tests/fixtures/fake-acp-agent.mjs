// Fake ACP agent used by acp-wire-mcp.test.ts and acp-wire-elicitation.test.ts.
// Speaks ndjson JSON-RPC over stdio: answers initialize/session/new/session/resume
// and records every session/new & session/resume params payload to CAPTURE_FILE
// (one JSON per line) so tests can assert the exact wire format.
//
// When FAKE_AGENT_ELICITATION=form|url is set, a session/prompt makes the agent
// behave like an eliciting agent (e.g. opencode asking a question):
//   1. capture the initialize params (clientCapabilities advertisement)
//   2. send an outgoing `elicitation/create` request and await the client response
//   3. capture the elicitation response payload exactly as received on the wire
//   4. reply to session/prompt with stopReason "end_turn"
//   5. (url mode only) send an `elicitation/complete` notification afterwards
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const captureFile = process.env.CAPTURE_FILE;
const elicitationMode = process.env.FAKE_AGENT_ELICITATION; // 'form' | 'url' | undefined

const rl = createInterface({ input: process.stdin });

let nextOutgoingId = 1000;
// outgoing request id -> continuation invoked with the client's response result
const pendingOutgoing = new Map();

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function request(method, params, onResult) {
  const id = nextOutgoingId++;
  pendingOutgoing.set(id, onResult);
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
}

function notify(method, params) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

function capture(entry) {
  if (captureFile) {
    appendFileSync(captureFile, JSON.stringify(entry) + '\n');
  }
}

function handlePrompt(msg) {
  if (!elicitationMode) {
    reply(msg.id, { stopReason: 'end_turn' });
    return;
  }

  const sessionId = msg.params?.sessionId ?? 'fake-acp-session-1';
  const params =
    elicitationMode === 'form'
      ? {
          sessionId,
          mode: 'form',
          message: 'How should I approach this refactoring?',
          requestedSchema: {
            type: 'object',
            properties: {
              strategy: { type: 'string', enum: ['conservative', 'balanced', 'aggressive'] },
            },
            required: ['strategy'],
          },
        }
      : {
          sessionId,
          mode: 'url',
          elicitationId: 'fake-oauth-001',
          url: 'https://agent.example.com/connect?elicitationId=fake-oauth-001',
          message: 'Please authorize access to your repositories.',
        };

  request('elicitation/create', params, (result) => {
    capture({ method: 'elicitation/create', response: result ?? null });
    reply(msg.id, { stopReason: 'end_turn' });
    if (elicitationMode === 'url') {
      notify('elicitation/complete', { elicitationId: 'fake-oauth-001' });
    }
  });
}

rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  // Response to an outgoing request (has id, no method)
  if (msg.id !== undefined && !msg.method) {
    const continuation = pendingOutgoing.get(msg.id);
    if (continuation) {
      pendingOutgoing.delete(msg.id);
      continuation(msg.result);
    }
    return;
  }

  if (msg.id === undefined || !msg.method) return; // ignore notifications

  switch (msg.method) {
    case 'initialize':
      if (elicitationMode) {
        capture({ method: 'initialize', params: msg.params });
      }
      reply(msg.id, {
        protocolVersion: 1,
        agentCapabilities: { mcpCapabilities: { http: true, sse: true } },
        agentInfo: { name: 'fake-acp-agent', version: '0.0.1' },
        authMethods: [],
      });
      break;
    case 'session/new':
    case 'session/resume':
      capture({ method: msg.method, params: msg.params });
      reply(msg.id, { sessionId: 'fake-acp-session-1' });
      break;
    case 'session/prompt':
      handlePrompt(msg);
      break;
    default:
      reply(msg.id, {});
  }
});
