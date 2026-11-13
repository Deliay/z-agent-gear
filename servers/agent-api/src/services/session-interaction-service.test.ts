import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * 轻量内存模型：模拟 MongoDB 的过滤语义（含 `$gt` / `$in` / PENDING 前置条件），
 * 让服务层 CAS / 幂等 / 单调收敛逻辑可在无 mongod 环境下稳定验证。
 */
type Row = Record<string, any>;

const store = new Map<string, Row>();
let seq = 0;

function matches(row: Row, filter: Record<string, any>): boolean {
  for (const [key, cond] of Object.entries(filter)) {
    if (key === '$or') {
      if (!(cond as Row[]).some((branch) => matches(row, branch))) return false;
      continue;
    }
    const value = row[key];
    if (cond && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
      if ('$gt' in cond && !(value > cond.$gt)) return false;
      if ('$in' in cond && !(cond.$in as unknown[]).some((v) => String(v) === String(value))) return false;
      if ('$ne' in cond && String(value) === String(cond.$ne)) return false;
      continue;
    }
    if (String(value) !== String(cond)) return false;
  }
  return true;
}

function applyUpdate(row: Row, update: Record<string, any>): void {
  if (update.$set) Object.assign(row, update.$set);
  for (const [key, value] of Object.entries(update.$push ?? {})) {
    row[key] = [...(row[key] ?? []), value];
  }
}

vi.mock('../models/session-interaction.js', () => ({
  SessionInteraction: {
    create: vi.fn(async (doc: Row) => {
      if (store.has(String(doc.interactionId))) {
        throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
      }
      seq += 1;
      const row: Row = { _id: `id-${seq}`, createdAt: new Date(), ...doc };
      store.set(String(doc.interactionId), row);
      return { toObject: () => row };
    }),
    findOne: vi.fn((filter: Row) => ({
      lean: async () => [...store.values()].find((row) => matches(row, filter)) ?? null,
    })),
    findOneAndUpdate: vi.fn((filter: Row, update: Row) => ({
      lean: async () => {
        const row = [...store.values()].find((candidate) => matches(candidate, filter));
        if (!row) return null;
        applyUpdate(row, update);
        return { ...row };
      },
    })),
    updateOne: vi.fn(async (filter: Row, update: Row) => {
      let modifiedCount = 0;
      for (const row of store.values()) {
        if (!matches(row, filter)) continue;
        applyUpdate(row, update);
        modifiedCount += 1;
      }
      return { modifiedCount };
    }),
    updateMany: vi.fn(async (filter: Row, update: Row) => {
      let modifiedCount = 0;
      for (const row of store.values()) {
        if (!matches(row, filter)) continue;
        applyUpdate(row, update);
        modifiedCount += 1;
      }
      return { modifiedCount };
    }),
    find: vi.fn((filter: Row) => ({
      sort: () => ({
        lean: async () =>
          [...store.values()]
            .filter((row) => matches(row, filter))
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
      }),
    })),
    distinct: vi.fn(async (field: string, filter: Row) =>
      [...new Set([...store.values()].filter((row) => matches(row, filter)).map((row) => String(row[field])))],
    ),
    deleteMany: vi.fn(async (filter: Row) => {
      let deletedCount = 0;
      for (const [key, row] of store.entries()) {
        if (!matches(row, filter)) continue;
        store.delete(key);
        deletedCount += 1;
      }
      return { deletedCount };
    }),
  },
}));

vi.mock('./todo-service.js', () => ({
  todoService: {
    resolveSessionTenantId: vi.fn(async () => null),
  },
}));

import { SessionInteraction } from '../models/session-interaction.js';
import { sessionInteractionService, SESSION_INTERACTION_TIMEOUT_MS } from './session-interaction-service.js';

const USER = 'user-1';
const OTHER_USER = 'user-2';
const SESSION = 'session-1';
const SESSION_2 = 'session-2';

beforeEach(() => {
  store.clear();
  seq = 0;
  vi.clearAllMocks();
});

function elicitationInput(overrides: Record<string, unknown> = {}) {
  return {
    requestId: 'req-elic-1',
    controllerId: 'ctrl-1',
    sessionId: SESSION,
    userId: USER,
    mode: 'form' as const,
    message: 'Need input',
    requestedSchema: { type: 'object', properties: { answer: { type: 'string' } } },
    ...overrides,
  };
}

function permissionInput(overrides: Record<string, unknown> = {}) {
  return {
    requestId: 'req-perm-1',
    controllerId: 'ctrl-1',
    sessionId: SESSION,
    userId: USER,
    toolCall: { toolCallId: 'tc-1', title: 'Bash: npm test', kind: 'execute' },
    options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }],
    ...overrides,
  };
}

describe('SessionInteractionService (T-SI)', () => {
  it('T-SI1: elicitation 创建 PENDING + expiresAt≈+60s + history 首条 PENDING(agent)', async () => {
    const before = Date.now();
    const { interaction, created } = await sessionInteractionService.createFromElicitationRequest(
      elicitationInput(),
    );

    expect(created).toBe(true);
    expect(interaction.status).toBe('PENDING');
    expect(interaction.kind).toBe('ELICITATION');
    const expiresAt = new Date(String(interaction.expiresAt)).getTime();
    expect(expiresAt - before).toBeGreaterThanOrEqual(SESSION_INTERACTION_TIMEOUT_MS - 1_000);
    expect(expiresAt - before).toBeLessThanOrEqual(SESSION_INTERACTION_TIMEOUT_MS + 5_000);
    const history = interaction.history as Array<Record<string, unknown>>;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ state: 'PENDING', actor: 'agent' });
  });

  it('T-SI2: 重复 requestId 幂等——只一张卡片，created=false', async () => {
    const first = await sessionInteractionService.createFromPermissionRequest(permissionInput());
    const second = await sessionInteractionService.createFromPermissionRequest(permissionInput());

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.interaction.id).toBe(first.interaction.id);
    expect(store.size).toBe(1);
  });

  it('T-SI3: respondElicitation accept——ACCEPTED + response.values + history(user)', async () => {
    await sessionInteractionService.createFromElicitationRequest(elicitationInput());

    const responded = await sessionInteractionService.respondElicitation({
      userId: USER,
      interactionId: 'req-elic-1',
      action: 'accept',
      values: { answer: 'yes' },
    });

    expect(responded?.status).toBe('ACCEPTED');
    expect(responded?.response).toMatchObject({ action: 'accept', values: { answer: 'yes' } });
    expect(responded?.respondedAt).toBeTruthy();
    const history = responded?.history as Array<Record<string, unknown>>;
    expect(history.map((event) => `${event.state}:${event.actor}`)).toEqual([
      'PENDING:agent',
      'ACCEPTED:user',
    ]);
  });

  it('T-SI4: respond 已终结后返回 null（不可重复作答）', async () => {
    await sessionInteractionService.createFromPermissionRequest(permissionInput());
    await sessionInteractionService.respondPermission({
      userId: USER,
      interactionId: 'req-perm-1',
      outcome: 'selected',
      optionId: 'allow_once',
    });

    const again = await sessionInteractionService.respondPermission({
      userId: USER,
      interactionId: 'req-perm-1',
      outcome: 'cancelled',
    });
    expect(again).toBeNull();

    const row = await SessionInteraction.findOne({ interactionId: 'req-perm-1' }).lean();
    expect(row?.status).toBe('ACCEPTED');
  });

  it('T-SI5: respond 已过期返回 null（expiresAt 已过）', async () => {
    await sessionInteractionService.createFromElicitationRequest(elicitationInput());
    store.get('req-elic-1')!.expiresAt = new Date(Date.now() - 1_000);

    const responded = await sessionInteractionService.respondElicitation({
      userId: USER,
      interactionId: 'req-elic-1',
      action: 'accept',
      values: {},
    });
    expect(responded).toBeNull();
  });

  it('T-SI6: 非本人 respond 返回 null', async () => {
    await sessionInteractionService.createFromElicitationRequest(elicitationInput());
    const responded = await sessionInteractionService.respondElicitation({
      userId: OTHER_USER,
      interactionId: 'req-elic-1',
      action: 'accept',
      values: {},
    });
    expect(responded).toBeNull();
  });

  it('T-SI7: resolved 单调——迟到的 timeout 不覆盖已 ACCEPTED', async () => {
    await sessionInteractionService.createFromPermissionRequest(permissionInput());
    await sessionInteractionService.respondPermission({
      userId: USER,
      interactionId: 'req-perm-1',
      outcome: 'selected',
      optionId: 'allow_once',
    });

    const converged = await sessionInteractionService.resolve({
      userId: USER,
      interactionId: 'req-perm-1',
      resolution: 'EXPIRED',
      detail: 'controller-api timeout (60s)',
    });
    expect(converged).toBe(0);
    expect(store.get('req-perm-1')?.status).toBe('ACCEPTED');
  });

  it('T-SI8: requestId 缺失按 sessionId 会话级批量兜底收敛 + history(system)', async () => {
    await sessionInteractionService.createFromElicitationRequest(elicitationInput());
    await sessionInteractionService.createFromElicitationRequest(
      elicitationInput({ requestId: 'req-elic-2' }),
    );

    const converged = await sessionInteractionService.resolve({
      userId: USER,
      sessionId: SESSION,
      resolution: 'CANCELLED',
      detail: 'socket disconnected',
    });
    expect(converged).toBe(2);

    for (const row of store.values()) {
      expect(row.status).toBe('CANCELLED');
      const last = row.history[row.history.length - 1];
      expect(last).toMatchObject({ state: 'CANCELLED', actor: 'system', detail: 'socket disconnected' });
    }
  });

  it('T-SI9: findPendingBySessionIds 剔除过期与终态，空集合短路', async () => {
    await sessionInteractionService.createFromElicitationRequest(elicitationInput());
    await sessionInteractionService.createFromElicitationRequest(
      elicitationInput({ requestId: 'req-elic-2', sessionId: SESSION_2 }),
    );
    store.get('req-elic-2')!.expiresAt = new Date(Date.now() - 1_000);

    expect(await sessionInteractionService.findPendingBySessionIds([])).toEqual([]);
    const pending = await sessionInteractionService.findPendingBySessionIds([SESSION, SESSION_2]);
    expect(pending).toEqual([SESSION]);
    expect(SessionInteraction.distinct).toHaveBeenCalledWith('sessionId', {
      sessionId: { $in: [SESSION, SESSION_2] },
      status: 'PENDING',
      expiresAt: { $gt: expect.any(Date) },
    });
  });

  it('T-SI10: markAgentCompleted 仅追加 history，不改 status；listBySession 按 createdAt 升序', async () => {
    await sessionInteractionService.createFromElicitationRequest(
      elicitationInput({ mode: 'url', url: 'https://example.com/auth', elicitationId: 'elic-9' }),
    );
    await sessionInteractionService.createFromElicitationRequest(
      elicitationInput({ requestId: 'req-elic-2' }),
    );

    const marked = await sessionInteractionService.markAgentCompleted('elic-9', USER);
    expect(marked).toBe(1);

    const rows = await sessionInteractionService.listBySession(SESSION);
    expect(rows.map((row) => row.interactionId)).toEqual(['req-elic-1', 'req-elic-2']);
    expect(rows[0].status).toBe('PENDING');
    const history = rows[0].history as Array<Record<string, unknown>>;
    expect(history[history.length - 1]).toMatchObject({ state: 'ACCEPTED', actor: 'agent' });
  });

  it('T-SI11: 超长 message 落库前截断到 4000', async () => {
    const { interaction } = await sessionInteractionService.createFromElicitationRequest(
      elicitationInput({ message: 'x'.repeat(5_000) }),
    );
    expect(String(interaction.message).length).toBe(4_000);
  });
});
