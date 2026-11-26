// 最小复现执行器：验证「MCP prompts 只以客户端斜杠命令形式出现，永远不进入模型上下文」。
//
// 场景 1（默认）：两个 MCP 服务（prompts 型 + tools 型，均带 Authorization 头）
//   - 期望 harness 对 prompts 型服务调用 prompts/list；对 tools 型服务不调用（按 initialize 能力门控）
//   - 期望 ACP 侧收到 available_commands_update，出现 `<server>:<prompt>` 命令
//   - 期望提示词正文（HELLO FROM MCP PROMPT）从未出现在任何 model-visible 的 session/update 里
// 场景 2（--no-headers）：同一 prompts 型服务但 ACP http 条目不带 headers
//   - 记录 harness 对该服务的请求数（用于记录「静默忽略」行为）
// 场景 3（resources）：resources 型服务
//   - 期望连接期只 initialize + tools/list（资源懒加载）
//   - 直接调用 resources/list / resources/read，验证资源通道可承载并返回片段正文（修复方向回归）
//
// 用法：
//   node tests/e2e/mcp-prompts/run.mjs            # 需要本机可执行 `opencode`
//   OPENCODE_BIN=/path/to/opencode node ...        # 指定二进制
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OPENCODE_BIN = process.env.OPENCODE_BIN ?? 'opencode';
const WORK = process.env.REPRO_WORKDIR ?? path.join(os.tmpdir(), 'zag-mcp-prompts-repro');
const PROMPT_TEXT = 'HELLO FROM MCP PROMPT';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

function resetWorkdir() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
}

function readLog(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function startStub({ variant, port, name, logFile }) {
  const child = spawn(process.execPath, [path.join(HERE, 'mcp-stub-server.mjs')], {
    env: {
      ...process.env,
      MCP_VARIANT: variant,
      MCP_STUB_PORT: String(port),
      MCP_STUB_NAME: name,
      MCP_STUB_LOG: logFile,
      MCP_STUB_PROMPT_TEXT: PROMPT_TEXT,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write(`[stub] ${String(d).slice(0, 300)}\n`));
  return child;
}

function runProbe({ servers, waitMs = 8000 }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HERE, 'acp-probe.mjs')], {
      env: {
        ...process.env,
        OPENCODE_BIN,
        ACP_CWD: WORK,
        ACP_WAIT_MS: String(waitMs),
        ACP_MCP_SERVERS: JSON.stringify(servers),
      },
      cwd: WORK,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const events = [];
    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const parsed = JSON.parse(trimmed);
        events.push(parsed);
        if (parsed.type === 'agent-capabilities') console.log(`agent: ${JSON.stringify(parsed)}`);
      } catch {
        events.push({ type: 'raw', line: trimmed });
      }
    });
    child.stderr.on('data', (d) => {
      const text = String(d);
      if (/error|fail|mcp/i.test(text)) process.stderr.write(`[probe] ${text.slice(0, 300)}\n`);
    });
    child.on('exit', () => resolve(events));
  });
}

async function scenarioWithServers() {
  console.log('\n=== 场景 1：prompts 型 + tools 型 MCP 服务（均带 Authorization 头） ===');
  const promptsLog = path.join(WORK, 'prompts-server.log');
  const toolsLog = path.join(WORK, 'tools-server.log');
  const promptsSvc = startStub({ variant: 'prompts', port: 7811, name: 'prompts-tools', logFile: promptsLog });
  const toolsSvc = startStub({ variant: 'tools', port: 7812, name: 'tools-only', logFile: toolsLog });
  await new Promise((r) => setTimeout(r, 600));

  try {
    const headers = [{ name: 'Authorization', value: 'Bearer repro-token' }];
    const events = await runProbe({
      servers: [
        { type: 'http', name: 'prompts-tools', url: 'http://127.0.0.1:7811/mcp', headers },
        { type: 'http', name: 'tools-only', url: 'http://127.0.0.1:7812/mcp', headers },
      ],
    });

    const promptsCalls = readLog(promptsLog).filter((e) => e.event === 'request');
    const toolsCalls = readLog(toolsLog).filter((e) => e.event === 'request');
    const promptsList = promptsCalls.filter((e) => e.method === 'prompts/list');
    const toolsPromptsList = toolsCalls.filter((e) => e.method === 'prompts/list');
    const commandUpdates = events.filter((e) => e.type === 'session-update' && e.sessionUpdate === 'available_commands_update');
    const allCommands = commandUpdates.flatMap((e) => e.availableCommands ?? []);
    const modelVisibleText = events
      .filter((e) => e.type === 'session-update' && e.sessionUpdate !== 'available_commands_update')
      .map((e) => e.text ?? '')
      .join('\n');

    check('harness 对 prompts 型服务调用 prompts/list', promptsList.length > 0, `calls=${promptsList.length}`);
    check(
      'harness 对 tools 型服务不调用 prompts/list（按 initialize 能力门控）',
      toolsPromptsList.length === 0,
      `calls=${toolsPromptsList.length}`,
    );
    check(
      'ACP 侧出现 MCP 提示词斜杠命令 prompts-tools:demo-prompt',
      allCommands.some((c) => c.name === 'prompts-tools:demo-prompt'),
      `commands=${allCommands.map((c) => c.name).join(',') || 'none'}`,
    );
    check(
      '提示词正文从未进入 model-visible 的 session/update（模型看不到提示词）',
      !modelVisibleText.includes(PROMPT_TEXT),
      `modelVisibleChars=${modelVisibleText.length}`,
    );
  } finally {
    promptsSvc.kill('SIGKILL');
    toolsSvc.kill('SIGKILL');
  }
}

async function scenarioWithoutHeaders() {
  console.log('\n=== 场景 2（补充观察）：ACP http MCP 条目不带 headers ===');
  const logFile = path.join(WORK, 'noheaders-server.log');
  const svc = startStub({ variant: 'prompts', port: 7813, name: 'no-headers', logFile });
  await new Promise((r) => setTimeout(r, 600));
  try {
    await runProbe({
      servers: [{ type: 'http', name: 'no-headers', url: 'http://127.0.0.1:7813/mcp' }],
      waitMs: 6000,
    });
    const calls = readLog(logFile).filter((e) => e.event === 'request');
    check(
      '不带 headers 的 http MCP 条目被 harness 静默忽略（无任何入站请求）',
      calls.length === 0,
      `requests=${calls.length}`,
    );
  } finally {
    svc.kill('SIGKILL');
  }
}

async function scenarioResources() {
  console.log('\n=== 场景 3（调研观察）：resources 型 MCP 服务的发现时机 ===');
  const logFile = path.join(WORK, 'resources-server.log');
  const svc = startStub({ variant: 'resources', port: 7815, name: 'res-svc', logFile });
  await new Promise((r) => setTimeout(r, 600));
  try {
    await runProbe({
      servers: [
        {
          type: 'http',
          name: 'res-svc',
          url: 'http://127.0.0.1:7815/mcp',
          headers: [{ name: 'Authorization', value: 'Bearer repro-token' }],
        },
      ],
      waitMs: 6000,
    });
    const calls = readLog(logFile).filter((e) => e.event === 'request');
    const methods = calls.map((e) => e.method);
    check(
      'resources 型服务在连接期被 initialize 并做 tools/list',
      methods.includes('initialize') && methods.includes('tools/list'),
      `methods=${methods.join(',')}`,
    );
    check(
      '连接期不主动 resources/list（资源由模型侧按需拉取，懒加载）',
      !methods.includes('resources/list'),
      `methods=${methods.join(',')}`,
    );

    // 修复方向回归：resources 通道确实能返回片段正文（模型侧按需读取的等价断言）
    const callStub = async (body) => {
      const response = await fetch('http://127.0.0.1:7815/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return await response.json();
    };
    const list = await callStub({ jsonrpc: '2.0', id: 101, method: 'resources/list' });
    const resource = list?.result?.resources?.[0];
    check(
      'resources/list 返回 URI/name/mimeType 形态的片段清单',
      Boolean(resource?.uri) && Boolean(resource?.name) && resource?.mimeType === 'text/markdown',
      `uri=${resource?.uri ?? 'none'}`,
    );
    const read = await callStub({
      jsonrpc: '2.0',
      id: 102,
      method: 'resources/read',
      params: { uri: resource?.uri },
    });
    check(
      'resources/read 返回片段正文（resources 可承载提示词内容）',
      read?.result?.contents?.[0]?.text === PROMPT_TEXT,
      `text=${read?.result?.contents?.[0]?.text ?? 'none'}`,
    );
  } finally {
    svc.kill('SIGKILL');
  }
}

resetWorkdir();
await scenarioWithServers();
await scenarioWithoutHeaders();
await scenarioResources();

const failed = results.filter((r) => !r.ok);
console.log(`\n=== 结果：${results.length - failed.length}/${results.length} PASS （工作目录 ${WORK}） ===`);
process.exit(failed.length === 0 ? 0 : 1);
