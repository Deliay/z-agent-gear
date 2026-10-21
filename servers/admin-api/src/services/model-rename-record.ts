import { ModelRenameRecord } from '../models/model-rename-record.js';

export interface ModelRenameRecordDto {
  id: string;
  modelId: string;
  providerId: string;
  providerName: string;
  oldName: string;
  newName: string;
  batchId: string;
  /** ISO 8601（admin 侧时间字段统一用 String 承载，见计划期裁决 1） */
  renamedAt: string;
}

export class ModelRenameRecordService {
  /** 只读台账：按整理时间倒序（同刻以 _id 倒序稳定）。 */
  async findAll(): Promise<ModelRenameRecordDto[]> {
    const records = await ModelRenameRecord.find().sort({ renamedAt: -1, _id: -1 }).lean();
    return records.map((record) => {
      const r = record as Record<string, unknown>;
      return {
        id: String(r._id),
        modelId: String(r.modelId),
        providerId: String(r.providerId),
        providerName: String(r.providerName),
        oldName: String(r.oldName),
        newName: String(r.newName),
        batchId: String(r.batchId),
        renamedAt: new Date(r.renamedAt as Date).toISOString(),
      };
    });
  }
}

export const modelRenameRecordService = new ModelRenameRecordService();
