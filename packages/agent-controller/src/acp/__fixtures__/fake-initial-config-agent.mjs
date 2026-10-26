#!/usr/bin/env node
/**
 * 测试用假 ACP Agent（真实 JSON-RPC over stdio 字节流）。
 *
 * 用途：验证「session/new 应答不含 configOptions → 异步 config_option_update
 * 通知到达 → bridge 挂起补应用并回读确认」的跨协议路径——这是 mock SDK
 * 单测覆盖不到的最后一公里（偶现失效的主因场景）。
 *
 * 参数：node fake-initial-config-agent.mjs <resultFile>
 * 行为：initialize → session/new（不带 configOptions）→ 200ms 后推送
 *       session/update(config_option_update) → 收到 session/set_config_option
 *       时记录参数并以请求值作为 currentValue 回全量快照。
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const resultFile = process.argv[2];

if (!resultFile) {
  process.stderr.write('resultFile argument is required\n');
  process.exit(2);
}

writeFileSync(resultFile, '');

const MODEL_OPTIONS = [
  { value: 'fake-model', name: 'Fake Model' },
  { value: 'requested-model', name: 'Requested Model' },
];

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function record(payload) {
  appendFileSync(resultFile, JSON.stringify(payload) + '\n');
}

function modelConfigOption(currentValue) {
  return {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue,
    options: MODEL_OPTIONS,
  };
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
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
        },
        authMethods: [],
        agentInfo: { name: 'FakeInitialConfigAgent', version: '1.0.0' },
      },
    });
    return;
  }

  if (message.method === 'session/new') {
    // 故意不携带 configOptions：模拟仅靠异步通知推送能力快照的 Agent
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'fake-session-1' } });
    setTimeout(() => {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'fake-session-1',
          update: {
            sessionUpdate: 'config_option_update',
            configOptions: [modelConfigOption('fake-model')],
          },
        },
      });
    }, 200);
    return;
  }

  if (message.method === 'session/set_config_option') {
    record({ setConfigOption: message.params });
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { configOptions: [modelConfigOption(message.params.value)] },
    });
    return;
  }

  if (message.method && 'id' in message) {
    // 其余请求（如 session/close）统一回空结果，避免阻塞；通知（无 id）不应答
    send({ jsonrpc: '2.0', id: message.id, result: {} });
  }
});

// 兜底：15 秒内未被测试回收则自行退出，避免进程泄漏
setTimeout(() => process.exit(0), 15000).unref();
