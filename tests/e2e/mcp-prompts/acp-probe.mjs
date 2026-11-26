// 最小 ACP 客户端探针（零依赖）：拉起 `opencode acp`，执行 initialize + session/new（带 MCP 服务），
// 把 ACP 侧收到的每种 session/update 与命令列表原样打印为 JSON 行，供断言脚本消费。
//
// 用法：
//   ACP_MCP_SERVERS='[{...}]' node acp-probe.mjs
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const OPENCODE_BIN = process.env.OPENCODE_BIN ?? 'opencode';
const CWD = process.env.ACP_CWD ?? process.cwd();
const WAIT_MS = Number(process.env.ACP_WAIT_MS ?? 8000);
const servers = JSON.parse(process.env.ACP_MCP_SERVERS ?? '[]');

const child = spawn(OPENCODE_BIN, ['acp'], {
  cwd: CWD,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: '1' },
});
child.stderr.on('data', (d) => {
  const text = String(d);
  process.stderr.write(`[agent-stderr] ${text.slice(0, 400)}\n`);
});

const rl = readline.createInterface({ input: child.stdout });
let nextId = 1;
const pending = new Map();

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
    return;
  }
  if (msg.method === 'session/update') {
    const update = msg.params?.update ?? {};
    const out = { type: 'session-update', sessionUpdate: update.sessionUpdate ?? null };
    if (update.sessionUpdate === 'available_commands_update') {
      out.availableCommands = update.availableCommands ?? [];
    } else if (update.content) {
      out.text = update.content.text ?? null;
    }
    console.log(JSON.stringify(out));
    return;
  }
  if (msg.method && msg.method !== 'session/update') {
    console.log(JSON.stringify({ type: 'request-from-agent', method: msg.method }));
  }
});

function send(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve) => pending.set(id, resolve));
}

const timer = setTimeout(() => {
  child.kill('SIGKILL');
  process.exit(0);
}, WAIT_MS + 30_000);

const init = await send('initialize', {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
});
console.log(
  JSON.stringify({
    type: 'agent-capabilities',
    mcpCapabilities: init.result?.agentCapabilities?.mcpCapabilities ?? null,
    agentVersion: init.result?.agentInfo?.version ?? null,
  }),
);

const created = await send('session/new', { cwd: CWD, mcpServers: servers });
if (created.error) {
  console.log(JSON.stringify({ type: 'session-new-error', error: created.error }));
} else {
  console.log(JSON.stringify({ type: 'session-new-ok', sessionId: created.result.sessionId }));
}

await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
clearTimeout(timer);
child.kill('SIGKILL');
process.exit(0);
