import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import mongoose from 'mongoose';
import { Model } from '../models/model.js';
import { Provider } from '../models/provider.js';
import { BillingApiCall } from '../models/billing-api-call.js';
import { BillingAccount } from '../models/billing-account.js';
import { accountService } from '../services/billing/account-service.js';
import { apiKeyService } from '../services/billing/api-key-service.js';
import { paymentService } from '../services/billing/payment.js';
import { encrypt } from '../services/crypto.js';
import { createBillingOpenAiRouter, resolveUsageFallback } from './billing-openai.js';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../services/billing/testing/mongo.js';
import type { BillingEventMessage } from '../services/billing/mq/publisher.js';

interface PublisherMock {
  enqueue: ReturnType<typeof vi.fn>;
  events: BillingEventMessage[];
}

let upstream: Server;
let upstreamUrl = '';
let upstreamMode: 'complete' | 'hang' = 'complete';
let gateway: Server;
let gatewayUrl = '';
let apiKeySecret = '';
let publisher: PublisherMock;

function startUpstream(): Promise<void> {
  return new Promise((resolve) => {
    upstream = createServer((req, res) => {
      if (upstreamMode === 'hang') return; // 保持连接不响应，供客户端中断测试
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            id: 'chatcmpl-test',
            object: 'chat.completion',
            created: 0,
            model: 'test-model',
            choices: [
              { index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        );
      });
    });
    upstream.listen(0, '127.0.0.1', () => {
      upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
      resolve();
    });
  });
}

async function seedProviderAndModel(): Promise<void> {
  const provider = await Provider.create({
    name: `p-${Date.now()}`,
    type: 'OpenAI',
    endpoint: upstreamUrl,
    encryptedCredential: encrypt('sk-test'),
    isEnabled: true,
    scope: 'global',
  });
  await Model.create({
    providerId: provider._id,
    name: 'test-model',
    isEnabled: true,
    scope: 'global',
    pricing: {
      inputPerMillion: 100,
      cachedInputPerMillion: 0,
      outputPerMillion: 100,
      isBillable: true,
    },
  });
}

async function seedAccountWithKey(): Promise<string> {
  const account = await accountService.getOrCreate(
    'front_user',
    new mongoose.Types.ObjectId().toString(),
    'gateway-user',
  );
  await paymentService.recharge({
    accountId: account.id,
    amountCents: 1_000_000,
    idempotentKey: `seed:${account.id}`,
    bizId: `seed:${account.id}`,
  });
  const created = await apiKeyService.create({
    accountId: account.id,
    ownerType: 'front_user',
    ownerId: 'gateway-user',
    name: 'k',
  });
  return created.secret;
}

describe('billing-openai gateway（R3/R6：完成/中断计费事实）', () => {
  beforeAll(async () => {
    await connectTestDb();
    await startUpstream();
    publisher = {
      // 记录事件并默认成功。
      enqueue: vi.fn(async (event: BillingEventMessage) => {
        publisher.events.push(event);
      }),
      events: [],
    };
    const app = express();
    app.use(express.json());
    app.use('/v1', createBillingOpenAiRouter({ publisher, logger: { warn: vi.fn() } }));
    await new Promise<void>((resolve) => {
      gateway = app.listen(0, '127.0.0.1', () => {
        gatewayUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
        resolve();
      });
    });
  }, 60000);

  afterAll(async () => {
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await disconnectTestDb();
  });

  beforeEach(async () => {
    await clearTestDb();
    publisher.events = [];
    publisher.enqueue.mockClear();
    upstreamMode = 'complete';
    await seedProviderAndModel();
    apiKeySecret = await seedAccountWithKey();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function callGateway(init: RequestInit = {}): Promise<Response> {
    return fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKeySecret}`,
      },
      body: JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }] }),
      ...init,
    });
  }

  it('正常完成：投递 model_call.completed，调用记录 status=completed', async () => {
    const res = await callGateway();
    expect(res.status).toBe(200);
    await res.json();

    // finalize 是异步事件投递 + 落库，等待其完成
    await vi.waitFor(() => {
      expect(publisher.events.some((e) => e.eventType === 'model_call.completed')).toBe(true);
    });
    expect(publisher.events.some((e) => e.eventType === 'model_call.aborted')).toBe(false);
    await vi.waitFor(async () => {
      const call = await BillingApiCall.findOne({});
      expect(call?.status).toBe('completed');
    });
  });

  it('R3：finalize 落库失败不把完成调用翻转为 aborted、不投双事件', async () => {
    // 第一次落库失败、重试成功（finalize 内部原地重试）。
    const real = BillingApiCall.updateOne.bind(BillingApiCall);
    const spy = vi.spyOn(BillingApiCall, 'updateOne');
    spy.mockImplementationOnce(() => Promise.reject(new Error('mongo down')) as never);
    spy.mockImplementation(real as never);

    const res = await callGateway();
    expect(res.status).toBe(200);
    await res.json();

    await vi.waitFor(() => {
      expect(publisher.events.some((e) => e.eventType === 'model_call.completed')).toBe(true);
    });
    // 不得因 finalize 失败而投递 aborted 事件
    expect(publisher.events.some((e) => e.eventType === 'model_call.aborted')).toBe(false);
    await vi.waitFor(async () => {
      const call = await BillingApiCall.findOne({});
      expect(call?.status).toBe('completed');
    });
  });

  it('R6：客户端中断 → 投递 model_call.aborted，调用记录 status=aborted', async () => {
    upstreamMode = 'hang';
    const controller = new AbortController();
    const pending = callGateway({ signal: controller.signal }).catch(() => undefined);
    // 等请求进入上游挂起后再中断
    await new Promise((resolve) => setTimeout(resolve, 250));
    controller.abort();
    await pending;

    await vi.waitFor(
      () => {
        expect(publisher.events.some((e) => e.eventType === 'model_call.aborted')).toBe(true);
      },
      { timeout: 5000 },
    );
    expect(publisher.events.some((e) => e.eventType === 'model_call.completed')).toBe(false);
    await vi.waitFor(async () => {
      const call = await BillingApiCall.findOne({});
      expect(call?.status).toBe('aborted');
    });
  });
});

/** 建议 15：缺失用量兜底（纯函数锚定）。 */
describe('resolveUsageFallback（缺失用量兜底）', () => {
  it('两段都为 0：input 用请求 prompt，output 用文本估算（无文本则用请求上限）', () => {
    const a = resolveUsageFallback({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }, 10, 100, '', false);
    expect(a.estimated).toBe(true);
    expect(a.usage.inputTokens).toBe(10);
    expect(a.usage.outputTokens).toBe(100);
    const b = resolveUsageFallback({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }, 10, 100, 'abcdefgh', false);
    expect(b.usage.outputTokens).toBe(2);
  });

  it('input 有值、output=0 且已产生文本 → 按文本估算 output（不再少计为 0）', () => {
    const r = resolveUsageFallback({ inputTokens: 10, cachedInputTokens: 0, outputTokens: 0 }, 10, 100, 'abcdefgh', false);
    expect(r.estimated).toBe(true);
    expect(r.usage.inputTokens).toBe(10);
    expect(r.usage.outputTokens).toBe(2);
  });

  it('input=0 但 output 有值 → 仅补 input', () => {
    const r = resolveUsageFallback({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 5 }, 10, 100, '', false);
    expect(r.estimated).toBe(true);
    expect(r.usage.inputTokens).toBe(10);
    expect(r.usage.outputTokens).toBe(5);
  });

  it('两段都有值 → 不估算', () => {
    const r = resolveUsageFallback({ inputTokens: 8, cachedInputTokens: 0, outputTokens: 5 }, 10, 100, 'abcdefgh', false);
    expect(r.estimated).toBe(false);
    expect(r.usage).toMatchObject({ inputTokens: 8, outputTokens: 5 });
  });
});
