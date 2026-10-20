import mongoose from 'mongoose';

/**
 * 历史重名整理台账（迁移 005 写入，只读）。
 *
 * `scope = 'global'` 内模型名要求全局唯一，存量重名在迁移中一次性改名；
 * 本集合逐条留档 `oldName → newName`，供后台「重名整理记录」查询与公告使用。
 * 记录不随模型/供应商删除而删除（审计留痕），因此 `providerName` 冗余存储。
 */
const modelRenameRecordSchema = new mongoose.Schema(
  {
    modelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Model', required: true, index: true },
    providerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Provider', required: true },
    /** 冗余留档：供应商删除后仍可读 */
    providerName: { type: String, required: true },
    oldName: { type: String, required: true },
    newName: { type: String, required: true },
    /** 迁移批次号（本期固定 `20261020-005`） */
    batchId: { type: String, required: true, index: true },
    renamedAt: { type: Date, required: true, index: true },
  },
  { collection: 'model_rename_records', timestamps: false },
);

modelRenameRecordSchema.index({ renamedAt: -1 });

export const ModelRenameRecord = mongoose.model('ModelRenameRecord', modelRenameRecordSchema);
export type IModelRenameRecord = mongoose.InferSchemaType<typeof modelRenameRecordSchema>;
