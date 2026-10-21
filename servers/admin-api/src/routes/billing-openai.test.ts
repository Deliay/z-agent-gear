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

/** 只读模型口径：cloudhosts 由 agent-api 写入，网关测试用原生集合插入。 */
async function seedCloudHost(input: { status?: string; userId?: string } = {}): Promise<string> {
  const _id = new mongoose.Types.ObjectId();
  await mongoose.connection.db!.collection('cloudhosts').insertOne({
    _id,
    userId: input.userId ?? new mongoose.Types.ObjectId().toString(),
    controllerId: new mongoose.Types.ObjectId(),
    status: input.status ?? 'RUNNING',
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return _id.toString();
}

/** 云电脑运行专用 Key：账号需有余额（系统模型仍走预扣费检查）。 */
async function seedCloudHostKey(
  cloudHostId?: string,
  expiresAt = new Date(Date.now() + 60 * 60 * 1000),
): Promise<{ secret: string; cloudHostId: string }> {
  const userId = new mongoose.Types.ObjectId().toString();
  const hostId = cloudHostId ?? (await seedCloudHost({ userId }));
  if (cloudHostId) {
    await mongoose.connection.db!.collection('cloudhosts').updateOne(
      { _id: new mongoose.Types.ObjectId(cloudHostId) },
      { $set: { userId: new mongoose.Types.ObjectId(userId) } },
    );
  }
  const account = await accountService.getOrCreate(
    'front_user',
    userId,
    'cloud-host-user',
  );
  await paymentService.recharge({
    accountId: account.id,
    amountCents: 1_000_000,
    idempotentKey: `seed-host:${account.id}`,
    bizId: `seed-host:${account.id}`,
  });
  const created = await apiKeyService.createCloudHostScopedKey({
    accountId: account.id,
    ownerType: 'front_user',
    ownerId: userId,
    name: 'host-key',
    cloudHostId: hostId,
    expiresAt,
  });
  return { secret: created.secret, cloudHostId: hostId };
}

/** 用户自定义模型（scope=user，无定价）。每次使用独立 provider 避免 (providerId,name) 唯一冲突。 */
async function seedCustomModel(
  name: string,
  options: { isEnabled?: boolean; sortOrder?: number } = {},
): Promise<void> {
  const provider = await Provider.create({
    name: `p-user-${name}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    type: 'OpenAI',
    endpoint: upstreamUrl,
    encryptedCredential: encrypt('sk-test'),
    isEnabled: true,
    scope: 'user',
  });
  await Model.create({
    providerId: provider._id,
    name,
    isCustom: true,
    isEnabled: options.isEnabled ?? true,
    sortOrder: options.sortOrder ?? 0,
    scope: 'user',
    pricing: null,
  });
}

/** 全局模型（可禁用），复用 beforeEach 已建的全局 provider。 */
async function seedGlobalModel(name: string, options: { isEnabled?: boolean } = {}): Promise<void> {
  const provider = await Provider.findOne({ scope: 'global' });
  await Model.create({
    providerId: provider!._id,
    name,
    isCustom: false,
    isEnabled: options.isEnabled ?? true,
    scope: 'global',
    pricing: {
      inputPerMillion: 100,
      cachedInputPerMillion: 0,
      outputPerMillion: 100,
      isBillable: true,
    },
  });
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

  async function callWithKey(secret: string, body: Record<string, unknown>): Promise<Response> {
    return fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify(body),
    });
  }

  async function listModels(secret: string): Promise<Response> {
    return fetch(`${gatewayUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
  }

  async function waitForCall(): Promise<{ billable?: boolean; cost?: number; cloudHostId?: unknown; status: string }> {
    let call: { billable?: boolean; cost?: number; cloudHostId?: unknown; status: string } | null = null;
    await vi.waitFor(async () => {
      const doc = await BillingApiCall.findOne({});
      expect(doc?.status).toBe('completed');
      call = doc as never;
    });
    return call!;
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

  // ===== Phase 2：cloud_host Key 模型范围 / 分流 / 归因 =====

  it('T-BK9: 云电脑 /v1/models = global enabled ∪ user enabled（含自定义、不含禁用）', async () => {
    const { secret } = await seedCloudHostKey();
    await seedCustomModel('custom-model');
    await seedGlobalModel('disabled-global', { isEnabled: false });
    await seedCustomModel('disabled-user', { isEnabled: false });

    const res = await listModels(secret);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { object: string; data: Array<{ id: string }> };
    expect(body.object).toBe('list');
    const ids = body.data.map((item) => item.id);
    expect(ids).toContain('test-model');
    expect(ids).toContain('custom-model');
    expect(ids).not.toContain('disabled-global');
    expect(ids).not.toContain('disabled-user');
    // 同名去重（global 优先）
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('T-BK10: 账号 /v1/models 回归 — 仅返回定价完整的 global 模型', async () => {
    await seedCustomModel('custom-model');
    const res = await listModels(apiKeySecret);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((item) => item.id)).toEqual(['test-model']);
  });

  it('T-BK11: 系统模型调用 — 计量/outbox、cloudHostId 归因、billable=true', async () => {
    const { secret, cloudHostId } = await seedCloudHostKey();
    const res = await callWithKey(secret, {
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    await res.json();

    const call = await waitForCall();
    expect(call.billable).toBe(true);
    expect(String(call.cloudHostId)).toBe(cloudHostId);
    await vi.waitFor(() => {
      expect(publisher.events.some((e) => e.eventType === 'model_call.completed')).toBe(true);
    });
  });

  it('T-BK12/T-BK13: 自定义模型无定价 → 代转发成功、不记账（billable=false,cost=0）、无 outbox', async () => {
    const { secret, cloudHostId } = await seedCloudHostKey();
    await seedCustomModel('custom-model');

    const res = await callWithKey(secret, {
      model: 'custom-model',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0].message.content).toBe('hi');

    const call = await waitForCall();
    expect(call.billable).toBe(false);
    expect(call.cost).toBe(0);
    expect(String(call.cloudHostId)).toBe(cloudHostId);
    expect(publisher.events).toHaveLength(0);
  });

  it('T-BK14: 同名系统/自定义模型 → 系统模型优先并计费', async () => {
    const { secret } = await seedCloudHostKey();
    // 独立 provider 上建同名用户模型（无定价）
    await seedCustomModel('test-model');

    const res = await callWithKey(secret, {
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    await res.json();

    const call = await waitForCall();
    expect(call.billable).toBe(true);
    await vi.waitFor(() => {
      expect(publisher.events.some((e) => e.eventType === 'model_call.completed')).toBe(true);
    });
  });

  it('T-BK15: 不存在/禁用模型 → 404 model_not_found；账号 Key 不可用自定义模型', async () => {
    const { secret } = await seedCloudHostKey();
    await seedCustomModel('disabled-user', { isEnabled: false });

    const missing = await callWithKey(secret, {
      model: 'does-not-exist',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe('model_not_found');

    const disabled = await callWithKey(secret, {
      model: 'disabled-user',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(disabled.status).toBe(404);

    // 账号 Key 仍只解析系统模型
    await seedCustomModel('account-custom');
    const accountCall = await callWithKey(apiKeySecret, {
      model: 'account-custom',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(accountCall.status).toBe(404);
  });

  it('T-BK5: 云电脑非 RUNNING 时网关直接 401（含 /models）', async () => {
    const startingHost = await seedCloudHost({ status: 'STARTING' });
    const { secret } = await seedCloudHostKey(startingHost);
    expect((await listModels(secret)).status).toBe(401);
    const res = await callWithKey(secret, {
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(401);
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
