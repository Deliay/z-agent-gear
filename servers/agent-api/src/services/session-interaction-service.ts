import { logger as rootLogger } from '../observability/logger.js';
import { SessionInteraction } from '../models/session-interaction.js';
import { todoService } from './todo-service.js';

const logger = rootLogger.child({ component: 'session-interaction-service' });

/** 作答时限唯一口径：与 controller-api `TIMEOUT_MS`（60s）对齐 */
export const SESSION_INTERACTION_TIMEOUT_MS = 60_000;
const MESSAGE_MAX_LENGTH = 4000;
const URL_MAX_LENGTH = 2048;

export type SessionInteractionKind = 'ELICITATION' | 'PERMISSION';
export type SessionInteractionStatus =
  | 'PENDING'
  | 'ACCEPTED'
  | 'DECLINED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'FAILED';
export type SessionInteractionResolution = 'EXPIRED' | 'CANCELLED' | 'FAILED';
export type SessionInteractionActor = 'agent' | 'user' | 'system';

export interface ElicitationInteractionInput {
  requestId: string;
  controllerId: string;
  sessionId: string;
  userId: string;
  mode: 'form' | 'url';
  message: string;
  toolCallId?: string;
  requestedSchema?: Record<string, unknown>;
  elicitationId?: string;
  url?: string;
}

export interface PermissionInteractionInput {
  requestId: string;
  controllerId: string;
  sessionId: string;
  userId: string;
  toolCall: {
    toolCallId: string;
    title?: string;
    kind?: string;
    rawInput?: unknown;
    locations?: Array<{ path: string; line?: number }>;
  };
  options: Array<{ optionId: string; name: string; kind: string }>;
}

export interface CreateInteractionResult {
  interaction: Record<string, unknown>;
  /** false = 幂等命中既有记录（重复触发不产生第二张卡片/第二条 SSE） */
  created: boolean;
}

export interface RespondElicitationInput {
  userId: string;
  interactionId: string;
  action: 'accept' | 'decline' | 'cancel';
  values?: Record<string, unknown>;
}

export interface RespondPermissionInput {
  userId: string;
  interactionId: string;
  outcome: string;
  optionId?: string;
}

export interface ResolveInteractionInput {
  userId: string;
  interactionId?: string;
  sessionId?: string;
  resolution: SessionInteractionResolution;
  detail?: string;
}

type Doc = Record<string, unknown>;

function truncate(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  return value.length > max ? value.slice(0, max) : value;
}

function toIso(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/** DB 文档 → GraphQL 契约形状（日期统一 ISO；id 取 _id） */
export function mapInteraction(doc: Doc): Record<string, unknown> {
  const history = Array.isArray(doc.history) ? (doc.history as Doc[]) : [];
  return {
    id: String(doc._id ?? doc.id ?? ''),
    sessionId: String(doc.sessionId ?? ''),
    interactionId: doc.interactionId,
    kind: doc.kind,
    status: doc.status,
    mode: doc.mode ?? null,
    message: doc.message ?? null,
    requestedSchema: doc.requestedSchema ?? null,
    url: doc.url ?? null,
    elicitationId: doc.elicitationId ?? null,
    toolCallId: doc.toolCallId ?? null,
    toolCall: doc.toolCall ?? null,
    options: doc.options ?? null,
    response: doc.response ?? null,
    expiresAt: toIso(doc.expiresAt),
    createdAt: toIso(doc.createdAt) ?? new Date(0).toISOString(),
    respondedAt: toIso(doc.respondedAt),
    resolvedAt: toIso(doc.resolvedAt),
    history: history.map((event) => ({
      state: event.state,
      at: toIso(event.at),
      actor: event.actor,
      detail: event.detail ?? null,
    })),
  };
}

function isDuplicateKeyError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: number }).code === 11000);
}

/**
 * 会话交互唯一读写口（创建 / CAS 收敛 / 历史追加 / pending 聚合）。
 *
 * - 写：所有终态写入经 `PENDING` 前置过滤 CAS（单调，不可回退、不可重复作答）；
 * - 创建：`interactionId` 唯一索引 + E11000 幂等回读（重复触发只一张卡片）；
 * - `expiresAt` = 事件到达 agent-api 时刻 + 60s（与 controller-api 超时对齐）。
 */
export class SessionInteractionService {
  private async tenantFields(sessionId: string): Promise<Record<string, unknown>> {
    const tenantId = await todoService.resolveSessionTenantId(sessionId);
    // 解析不到时不写 tenantId，由 applyTenantScope 兜底（个人租户），与 todo 现有口径一致
    return tenantId ? { tenantId } : {};
  }

  private async createInteraction(doc: Doc): Promise<CreateInteractionResult> {
    try {
      const created = await SessionInteraction.create(doc);
      return { interaction: mapInteraction(created.toObject() as Doc), created: true };
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      const existing = await SessionInteraction.findOne({
        interactionId: doc.interactionId as string,
        userId: doc.userId as string,
      }).lean();
      if (!existing) throw error;
      // 幂等命中：既有记录视为已存在（不重复推送通知）
      return { interaction: mapInteraction(existing as Doc), created: false };
    }
  }

  async createFromElicitationRequest(data: ElicitationInteractionInput): Promise<CreateInteractionResult> {
    const now = new Date();
    const tenant = await this.tenantFields(data.sessionId);
    return this.createInteraction({
      userId: data.userId,
      ...tenant,
      sessionId: data.sessionId,
      interactionId: data.requestId,
      kind: 'ELICITATION',
      status: 'PENDING',
      mode: data.mode,
      message: truncate(data.message, MESSAGE_MAX_LENGTH),
      requestedSchema: data.requestedSchema,
      url: truncate(data.url, URL_MAX_LENGTH),
      elicitationId: data.elicitationId,
      toolCallId: data.toolCallId,
      expiresAt: new Date(now.getTime() + SESSION_INTERACTION_TIMEOUT_MS),
      history: [{ state: 'PENDING', at: now, actor: 'agent' }],
    });
  }

  async createFromPermissionRequest(data: PermissionInteractionInput): Promise<CreateInteractionResult> {
    const now = new Date();
    const tenant = await this.tenantFields(data.sessionId);
    const message = data.toolCall.title || data.toolCall.toolCallId;
    return this.createInteraction({
      userId: data.userId,
      ...tenant,
      sessionId: data.sessionId,
      interactionId: data.requestId,
      kind: 'PERMISSION',
      status: 'PENDING',
      message: truncate(message, MESSAGE_MAX_LENGTH),
      toolCallId: data.toolCall.toolCallId,
      toolCall: data.toolCall,
      options: data.options,
      expiresAt: new Date(now.getTime() + SESSION_INTERACTION_TIMEOUT_MS),
      history: [{ state: 'PENDING', at: now, actor: 'agent' }],
    });
  }

  /**
   * CAS 收敛：仅 `{interactionId, userId, status:'PENDING'}` 且未过期可写终态。
   * 未命中返回 null（已终结 / 已过期 / 非本人），调用方不得 publish 回 Agent。
   */
  private async casRespond(params: {
    userId: string;
    interactionId: string;
    status: SessionInteractionStatus;
    response: Record<string, unknown>;
  }): Promise<Record<string, unknown> | null> {
    const now = new Date();
    const result = await SessionInteraction.findOneAndUpdate(
      {
        interactionId: params.interactionId,
        userId: params.userId,
        status: 'PENDING',
        expiresAt: { $gt: now },
      },
      {
        $set: {
          status: params.status,
          response: params.response,
          respondedAt: now,
          resolvedAt: now,
        },
        $push: {
          history: { state: params.status, at: now, actor: 'user' },
        },
      },
      { returnDocument: 'after' },
    ).lean();
    if (!result) {
      logger.debug(
        { interactionId: params.interactionId, status: params.status },
        'respond CAS missed (already terminal, expired or not owner)',
      );
      return null;
    }
    return mapInteraction(result as Doc);
  }

  async respondElicitation(input: RespondElicitationInput): Promise<Record<string, unknown> | null> {
    const status: SessionInteractionStatus =
      input.action === 'accept' ? 'ACCEPTED' : input.action === 'decline' ? 'DECLINED' : 'CANCELLED';
    return this.casRespond({
      userId: input.userId,
      interactionId: input.interactionId,
      status,
      response: {
        action: input.action,
        ...(input.action === 'accept' && input.values ? { values: input.values } : {}),
      },
    });
  }

  async respondPermission(input: RespondPermissionInput): Promise<Record<string, unknown> | null> {
    const status: SessionInteractionStatus =
      input.outcome === 'selected' ? 'ACCEPTED' : 'CANCELLED';
    return this.casRespond({
      userId: input.userId,
      interactionId: input.interactionId,
      status,
      response: {
        outcome: input.outcome,
        ...(input.optionId ? { optionId: input.optionId } : {}),
      },
    });
  }

  /**
   * 服务端权威终态收敛（timeout / cancelled / unsupported_mode）。
   *
   * 单调：仅 `PENDING → 终态`；缺 `interactionId` 时按 `sessionId + userId` 会话级批量兜底
   * （沿用 elicitation 现有语义）。返回收敛条数。
   */
  async resolve(input: ResolveInteractionInput): Promise<number> {
    if (!input.userId) return 0;
    const now = new Date();
    const filter: Record<string, unknown> = { userId: input.userId, status: 'PENDING' };
    if (input.interactionId) {
      filter.interactionId = input.interactionId;
    } else if (input.sessionId) {
      filter.sessionId = input.sessionId;
    } else {
      return 0;
    }

    const update = {
      $set: { status: input.resolution, resolvedAt: now },
      $push: {
        history: {
          state: input.resolution,
          at: now,
          actor: 'system',
          ...(input.detail ? { detail: input.detail } : {}),
        },
      },
    };

    const result = input.interactionId
      ? await SessionInteraction.updateOne(filter, update)
      : await SessionInteraction.updateMany(filter, update);
    return result.modifiedCount ?? 0;
  }

  /**
   * `elicitation:complete`（URL 模式外部交互完成）：仅向 history 追加 `ACCEPTED(agent)` 记录，
   * **不改 status**（用户「打开链接」时由 respond 完成收敛）。
   */
  async markAgentCompleted(elicitationId: string, userId: string): Promise<number> {
    if (!elicitationId || !userId) return 0;
    const now = new Date();
    const result = await SessionInteraction.updateMany(
      { elicitationId, userId },
      {
        $push: {
          history: { state: 'ACCEPTED', at: now, actor: 'agent', detail: 'agent completed' },
        },
      },
    );
    return result.modifiedCount ?? 0;
  }

  /** 实例级一次查询：存在「待处理且未过期」交互的会话 id 集合（空集合短路） */
  async findPendingBySessionIds(sessionIds: string[], now: Date = new Date()): Promise<string[]> {
    const ids = sessionIds.filter(Boolean);
    if (ids.length === 0) return [];
    const found = (await SessionInteraction.distinct('sessionId', {
      sessionId: { $in: ids },
      status: 'PENDING',
      expiresAt: { $gt: now },
    })) as unknown[];
    return found.map((id) => String(id));
  }

  async listBySession(sessionId: string): Promise<Record<string, unknown>[]> {
    const rows = await SessionInteraction.find({ sessionId }).sort({ createdAt: 1 }).lean();
    return (rows as Doc[]).map(mapInteraction);
  }

  async findByInteractionId(
    interactionId: string,
    userId: string,
  ): Promise<Record<string, unknown> | null> {
    const row = await SessionInteraction.findOne({ interactionId, userId }).lean();
    return row ? mapInteraction(row as Doc) : null;
  }

  /** 会话删除 / 导入覆盖连带清理（与 AcpMessage 同点） */
  async deleteBySession(sessionId: string): Promise<number> {
    const result = await SessionInteraction.deleteMany({ sessionId });
    return result.deletedCount ?? 0;
  }
}

export const sessionInteractionService = new SessionInteractionService();
