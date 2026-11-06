import mongoose from 'mongoose';
import { applyTenantScope } from '../services/tenant-scope.js';

const { Schema } = mongoose;

/** 评审文件（展示相对路径 + 解析后绝对路径） */
const sessionReviewFileSchema = new Schema(
  {
    path: { type: String, required: true },
    absPath: { type: String, required: true },
  },
  { _id: false },
);

/**
 * 会话内建 Review（Agent 经平台 MCP `agent-session-preview-tools.review` 发起）。
 *
 * 状态机：PENDING →（submit CAS）APPROVED / REJECTED / COMMENTED
 *                    →（超时 / 会话结束 CAS）CANCELLED（cancelReason: timeout | session_closed）。
 *
 * 多租户：`tenantId` 声明 + `applyTenantScope`（裁决 11）；查询一律 `actorFilter(userId)`
 * （多租户二期口径），禁止显式写 userId。无唯一索引；查询索引由迁移 023 幂等创建。
 */
const sessionReviewSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
  sessionId: { type: Schema.Types.ObjectId, ref: 'Session', required: true, index: true },
  controllerId: { type: Schema.Types.ObjectId, ref: 'Controller', required: true },
  files: [sessionReviewFileSchema],
  summary: { type: String },
  status: {
    type: String,
    enum: ['PENDING', 'APPROVED', 'REJECTED', 'COMMENTED', 'CANCELLED'],
    default: 'PENDING',
  },
  /** { [file: string]: ReviewComment[] }，提交时写入；PENDING/CANCELLED 为 null */
  fileReviews: { type: Schema.Types.Mixed },
  comment: { type: String },
  /** timeout | session_closed（status=CANCELLED 时） */
  cancelReason: { type: String },
  createdAt: { type: Date, default: Date.now },
  resolvedAt: { type: Date },
});

applyTenantScope(sessionReviewSchema);

export const SessionReview = mongoose.model('SessionReview', sessionReviewSchema);
