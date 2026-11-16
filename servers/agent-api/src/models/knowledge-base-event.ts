import mongoose from 'mongoose';

/**
 * 知识库事件（集合 `knowledgebaseevents`，agent-api 唯一写方；需求 #495）。
 *
 * - **追加式事件溯源**：CREATE / UPDATE / DELETE 各记录一条**完整内容快照**
 *   （DELETE 保留删除前最后内容），无任何更新/删除入口（仅删除知识库时级联清理）。
 * - 删除文档不删历史、同路径重建历史延续；全库/单路径历史恒按 `createdAt` 倒序。
 * - `actorName` 为写入时点快照（账户改名不影响历史），由 `appendEvent` 解析。
 * - 不挂任何 scope 插件（同 `knowledgebases`）；无 TTL（本期取舍：删除库时级联清理）。
 */
export const KNOWLEDGE_BASE_EVENT_OPS = ['CREATE', 'UPDATE', 'DELETE'] as const;

export type KnowledgeBaseEventOp = (typeof KNOWLEDGE_BASE_EVENT_OPS)[number];

const knowledgeBaseEventSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true },
    knowledgeBaseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'KnowledgeBase',
      required: true,
    },
    path: { type: String, required: true },
    op: { type: String, enum: KNOWLEDGE_BASE_EVENT_OPS, required: true },
    title: { type: String, required: true },
    tags: { type: [String], default: [] },
    description: { type: String, default: '' },
    content: { type: String, default: '' },
    actorId: { type: String, required: true },
    actorName: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: 'knowledgebaseevents', timestamps: false },
);

// 全库历史（设置页）：createdAt 倒序
knowledgeBaseEventSchema.index(
  { knowledgeBaseId: 1, createdAt: -1 },
  { name: 'knowledge_base_event_recent' },
);
// 单路径历史：同路径全部版本（含删除前与历次重建）
knowledgeBaseEventSchema.index(
  { knowledgeBaseId: 1, path: 1, createdAt: -1 },
  { name: 'knowledge_base_event_path_recent' },
);

export const KnowledgeBaseEvent = mongoose.model(
  'KnowledgeBaseEvent',
  knowledgeBaseEventSchema,
);
export type IKnowledgeBaseEvent = mongoose.InferSchemaType<typeof knowledgeBaseEventSchema>;
