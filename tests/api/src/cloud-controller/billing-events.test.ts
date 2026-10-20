import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';

// T-1：本套件按文档口径读取 `CLOUD_CONTROLLER_INTERNAL_TOKEN`（此前误读 INTERNAL_API_TOKEN，
// 导致按 AGENTS.md 运行时 describe.skip 恒不执行 = 假绿）。未提供 token 时显式跳过而非静默通过。
const CLOUD_URL = process.env.CLOUD_CONTROLLER_URL || 'http://localhost:10004';
const TOKEN = process.env.CLOUD_CONTROLLER_INTERNAL_TOKEN || process.env.INTERNAL_API_TOKEN || '';

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
}

async function mongoDb(): Promise<mongoose.mongo.Db | null> {
  const uri = process.env.MONGODB_URI;
  if (!uri) return null;
  if (mongoose.connection.readyState === 0) await mongoose.connect(uri);
  return mongoose.connection.db ?? null;
}

describe.skipIf(!TOKEN)('cloud-controller 计费字段与强拆原因', () => {
  it('T-CC-B4/B8: 创建容器携带 billingAccountId，A.3 透出计费字段', async () => {
    const created = await fetch(`${CLOUD_URL}/internal/containers`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ purpose: 'idle', billingAccountId: 'acct-e2e' }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      id: string;
      billingAccountId: string | null;
      billingStartedAt: string | null;
    };
    expect(body.billingAccountId).toBe('acct-e2e');
    expect(body.billingStartedAt).toBeNull();

    const list = await fetch(`${CLOUD_URL}/internal/containers`, { headers: authHeaders() });
    const items = (await list.json()) as Array<{ id: string; billingAccountId: string | null }>;
    expect(items.find((item) => item.id === body.id)?.billingAccountId).toBe('acct-e2e');
  });

  it('T-CC-B7: DELETE 带 reason 写入 exitReason', async () => {
    const created = await fetch(`${CLOUD_URL}/internal/containers`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ purpose: 'idle' }),
    });
    const body = (await created.json()) as { id: string };
    const reason = '余额不足超过 10 分钟，强制销毁';
    const res = await fetch(
      `${CLOUD_URL}/internal/containers/${body.id}?reason=${encodeURIComponent(reason)}`,
      { method: 'DELETE', headers: authHeaders() },
    );
    expect(res.status).toBe(200);

    const list = await fetch(`${CLOUD_URL}/internal/containers`, { headers: authHeaders() });
    const items = (await list.json()) as Array<{ id: string; exitReason: string | null }>;
    expect(items.find((item) => item.id === body.id)?.exitReason).toBe(reason);
  });

  /**
   * T-1：真实事件链路断言——就绪→销毁后 outbox 出现两条事实记录。
   *
   * 外部无法取得一次性 token 完成 worker 回连，因此这里直接在共享 Mongo 中把容器置为
   * 「已计费起点」再触发销毁，验证 `container.destroyed` 确实落到 `billingoutbox`；
   * 未提供 MONGODB_URI 时跳过（保持套件在纯 HTTP 环境可运行）。
   */
  describe.skipIf(!process.env.MONGODB_URI)('事件链路（需 MONGODB_URI）', () => {
    it('T-CC-B11: 已计费容器销毁后 billingoutbox 落一条 container.destroyed', async () => {
      const db = await mongoDb();
      if (!db) return;
      const created = await fetch(`${CLOUD_URL}/internal/containers`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ purpose: 'idle', billingAccountId: 'acct-evt' }),
      });
      const body = (await created.json()) as { id: string };
      const containerId = body.id;
      const startedAt = new Date(Date.now() - 60_000);
      await db
        .collection('cloudcontainers')
        .updateOne(
          { _id: new mongoose.Types.ObjectId(containerId) },
          { $set: { billingStartedAt: startedAt } },
        );

      const res = await fetch(`${CLOUD_URL}/internal/containers/${containerId}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);

      // relay 是异步的：轮询 outbox 直到出现（或超时）。
      let record: Record<string, unknown> | null = null;
      for (let i = 0; i < 40 && !record; i += 1) {
        record = (await db.collection('billingoutbox').findOne({
          eventId: `container.destroyed:${containerId}`,
        })) as Record<string, unknown> | null;
        if (!record) await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect(record).toBeTruthy();
      expect((record as { producer?: string }).producer).toBe('cloud-controller');
      expect((record as { routingKey?: string }).routingKey).toBe('container.destroyed');
    });
  });
});
