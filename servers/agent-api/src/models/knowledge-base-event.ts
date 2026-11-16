import mongoose from 'mongoose';

/**
 * 知识库事件（集合 `knowledgebaseevents`，agent-api 唯一写方；需求 #495 / #541）。
 *
 * - **追加式事件溯源**：CREATE / UPDATE / DELETE / MOVE 各记录一条**完整内容快照**
 *   （DELETE 保留删除前最后内容，MOVE 记录移动时点内容），无任何公共更新/删除入口
 *   （仅删除知识库时级联清理）。
 * - **唯一受控例外（#541 / 提案 D1）**：`knowledge-base-service.moveDocument` 内部
 *   `updateMany` 改写该路径全部历史事件的 `path`，使历史随文档带入新路径；MOVE 事件自身
 *   用 `fromPath` 记录原路径。该改写不暴露为任何公共入口。
 * - 删除文档不删历史、同路径重建历史延续；全库/单路径历史恒按 `createdAt` 倒序。
 * - `actorName` 为写入时点快照（账户改名不影响历史），由 `appendEvent` 解析。
 * - 不挂任何 scope 插件（同 `knowledgebases`）；无 TTL（本期取舍：删除库时级联清理）。
 */
export const KNOWLEDGE_BASE_EVENT_OPS = ['CREATE', 'UPDATE', 'DELETE', 'MOVE'] as const;

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
    // 仅 MOVE 事件写入（原路径）；存量事件无此字段，读取为 undefined → GraphQL null
    fromPath: { type: String },
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
