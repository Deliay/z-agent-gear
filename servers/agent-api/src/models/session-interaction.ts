import mongoose from 'mongoose';
import { applyTenantScope } from '../services/tenant-scope.js';

const { Schema } = mongoose;

/** 状态迁移记录（`_id:false` 子文档，按 at 升序） */
const sessionInteractionEventSchema = new Schema(
  {
    state: {
      type: String,
      enum: ['PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'EXPIRED', 'FAILED'],
      required: true,
    },
    at: { type: Date, required: true },
    actor: { type: String, required: true },
    detail: { type: String },
  },
  { _id: false },
);

const sessionInteractionResponseSchema = new Schema(
  {
    action: { type: String },
    outcome: { type: String },
    optionId: { type: String },
    values: { type: Schema.Types.Mixed },
  },
  { _id: false },
);

/**
 * 会话交互（Elicitation / Ask Permission）作为一等会话内容持久化。
 *
 * 状态机：PENDING → {ACCEPTED, DECLINED, CANCELLED, EXPIRED, FAILED}，仅允许从 PENDING 迁移；
 * 所有终态写入统一走 `SessionInteractionService` 的 CAS，禁止第二写入点。
 *
 * 多租户：`tenantId` 声明 + `applyTenantScope`（新增带 userId 集合的双注册要求：
 * `models/tenant-isolation.test.ts` 与迁移 013 的 `TENANT_ID_COLLECTIONS`）。
 * 读路径不挂 workspace-scope 插件：一律经「会话归属校验」访问（与 acpmessages 同口径）。
 */
const sessionInteractionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    sessionId: { type: Schema.Types.ObjectId, ref: 'Session', required: true, index: true },
    /** = requestId：全局唯一幂等键（重复触发只产生一张卡片） */
    interactionId: { type: String, required: true },
    kind: { type: String, enum: ['ELICITATION', 'PERMISSION'], required: true },
    status: {
      type: String,
      enum: ['PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'EXPIRED', 'FAILED'],
      default: 'PENDING',
    },
    /** form | url（仅 elicitation） */
    mode: { type: String, enum: ['form', 'url'] },
    /** 提问说明 / 审批标题（≤4000，落库前截断） */
    message: { type: String, maxlength: 4000 },
    requestedSchema: { type: Schema.Types.Mixed },
    /** url 模式链接（≤2048，仅 http/https，controller 侧已校验） */
    url: { type: String, maxlength: 2048 },
    elicitationId: { type: String },
    toolCallId: { type: String },
    toolCall: { type: Schema.Types.Mixed },
    options: { type: [Schema.Types.Mixed] },
    response: { type: sessionInteractionResponseSchema, default: undefined },
    /** 作答截止 = 创建时刻 + 60s（与 controller-api TIMEOUT_MS 对齐） */
    expiresAt: { type: Date },
    respondedAt: { type: Date },
    resolvedAt: { type: Date },
    history: { type: [sessionInteractionEventSchema], default: [] },
  },
  { timestamps: true },
);

// 查询索引（生产 autoIndex=false 时由迁移 025 显式兜底创建，声明与迁移保持一致）
sessionInteractionSchema.index(
  { interactionId: 1 },
  { unique: true, name: 'uniq_session_interaction_id' },
);
sessionInteractionSchema.index(
  { sessionId: 1, createdAt: 1 },
  { name: 'session_interaction_session_created' },
);
sessionInteractionSchema.index(
  { sessionId: 1, status: 1, expiresAt: 1 },
  { name: 'session_interaction_session_status_expires' },
);
sessionInteractionSchema.index(
  { elicitationId: 1 },
  { sparse: true, name: 'session_interaction_elicitation' },
);

applyTenantScope(sessionInteractionSchema);

export const SessionInteraction = mongoose.model('SessionInteraction', sessionInteractionSchema);
export type ISessionInteraction = mongoose.InferSchemaType<typeof sessionInteractionSchema>;
