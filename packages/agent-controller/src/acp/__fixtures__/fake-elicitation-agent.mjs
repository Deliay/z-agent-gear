#!/usr/bin/env node
/**
 * 测试用假 ACP Agent（真实 JSON-RPC over stdio 字节流）。
 *
 * 用途：验证「SDK 是否把 Agent 发起的 elicitation/create 路由到客户端
 * unstable_createElicitation」——这是 mock SDK 单测覆盖不到的最后一公里。
 *
 * 参数：node fake-elicitation-agent.mjs <mode> <resultFile>
 * 行为：initialize → session/new → 立即发起 elicitation/create → 等待响应
 *       → 把收到的响应 JSON 写入 resultFile 后退出。
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const mode = process.argv[2] ?? 'form';
const resultFile = process.argv[3];
const ELICITATION_ID = 100;

if (!resultFile) {
  process.stderr.write('resultFile argument is required\n');
  process.exit(2);
}

writeFileSync(resultFile, '');

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function record(payload) {
  appendFileSync(resultFile, JSON.stringify(payload) + '\n');
}

function sendElicitation() {
  const params = {
    mode,
    sessionId: 'fake-session-1',
    message: 'Fake agent needs input',
    ...(mode === 'url'
      ? { elicitationId: 'elic-1', url: 'https://example.com/auth' }
      : { requestedSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] } }),
  };
  send({ jsonrpc: '2.0', id: ELICITATION_ID, method: 'elicitation/create', params });
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }

  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, embeddedContext: true },
          sessionCapabilities: { resume: {}, close: {}, list: {}, delete: {} },
        },
        authMethods: [],
        agentInfo: { name: 'FakeAgent', version: '1.0.0' },
      },
    });
    return;
  }

  if (message.method === 'session/new') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        sessionId: 'fake-session-1',
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: 'fake-model',
            options: [{ value: 'fake-model', name: 'Fake Model' }],
          },
        ],
      },
    });
    // session/new 应答后立即发起问询（模拟真实 Agent 在回合中请求用户输入）
    setImmediate(sendElicitation);
    return;
  }

  if (message.id === ELICITATION_ID && ('result' in message || 'error' in message)) {
    record({ elicitationResponse: message.result ?? message.error });
    process.exit(0);
  }

  if (message.method) {
    // 其余请求（如 session/close）统一回空结果，避免阻塞
    send({ jsonrpc: '2.0', id: message.id, result: {} });
  }
});

// 兜底：8 秒内未收到问询响应则退出，避免测试挂死
setTimeout(() => {
  record({ timeout: true });
  process.exit(3);
}, 8000).unref();
