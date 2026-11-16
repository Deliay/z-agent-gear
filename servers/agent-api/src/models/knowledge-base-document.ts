import mongoose from 'mongoose';

/**
 * 知识库文档（集合 `knowledgebasedocuments`，agent-api 唯一写方；需求 #495）。
 *
 * - **仅存活动文档**：删除即释放路径（硬删除），历史由 `knowledgebaseevents` 追加式事件承担；
 *   同路径重建 = 新 CREATE 事件接续在历史尾部。
 * - 不挂任何 scope 插件（同 `knowledgebases`，见模型注释与提案 D2）。
 * - `path` 为归一化路径（以 `/` 开头、去末尾 `/`、无空段/控制字符），**库内唯一**——
 *   唯一索引 `uniq_knowledge_base_doc_path` `{knowledgeBaseId,path}`（与迁移 028 同名同键），
 *   同索引亦支撑路径前缀查询（`path: {$regex: '^<escaped>'}`）。
 * - 校验口径（服务层唯一事实源）：title trim 1..200 / tags ≤16 且单项 trim 1..32 去重 /
 *   description ≤1024 / content ≤262144 字符。
 */
const knowledgeBaseDocumentSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true },
    knowledgeBaseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'KnowledgeBase',
      required: true,
    },
    path: { type: String, required: true },
    title: { type: String, required: true },
    tags: { type: [String], default: [] },
    description: { type: String, default: '' },
    content: { type: String, default: '' },
    createdBy: { type: String, required: true },
    updatedBy: { type: String, required: true },
  },
  { collection: 'knowledgebasedocuments', timestamps: true },
);

// 库内路径唯一（迁移 028 同名同键；服务层预检 + E11000 兜底）
knowledgeBaseDocumentSchema.index(
  { knowledgeBaseId: 1, path: 1 },
  { unique: true, name: 'uniq_knowledge_base_doc_path' },
);

export const KnowledgeBaseDocument = mongoose.model(
  'KnowledgeBaseDocument',
  knowledgeBaseDocumentSchema,
);
export type IKnowledgeBaseDocument = mongoose.InferSchemaType<typeof knowledgeBaseDocumentSchema>;
