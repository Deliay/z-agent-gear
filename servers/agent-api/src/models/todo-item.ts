import mongoose from 'mongoose';

const { Schema } = mongoose;

const todoItemSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type: { type: String, enum: ['permission_request', 'elicitation_request', 'harness_login_request', 'workflow_intervention'], required: true },
  priority: { type: String, enum: ['immediate', 'urgent', 'medium', 'low'], required: true },
  title: { type: String, required: true },
  description: { type: String },
  isRead: { type: Boolean, default: false },
  data: {
    requestId: String,
    sessionId: Schema.Types.ObjectId,
    toolCallId: String,
    options: [{
      optionId: String,
      name: String,
      kind: String,
    }],
    toolCall: {
      toolCallId: String,
      title: String,
      kind: String,
      rawInput: Schema.Types.Mixed,
      locations: [{ _id: false, path: String, line: Number }],
    },
  },
  elicitationData: {
    requestId: String,
    sessionId: Schema.Types.ObjectId,
    toolCallId: String,
    mode: { type: String, enum: ['form', 'url'] },
    message: String,
    requestedSchema: Schema.Types.Mixed,
    elicitationId: String,
    url: String,
  },
  // harness 登录引导（Kimi Code）：required 事件落库，链接/验证码为 `kimi login` stdio 原文
  harnessLoginData: {
    requestId: String,
    controllerId: String,
    sessionId: Schema.Types.ObjectId,
    serverType: String,
    trigger: String,
    url: String,
    userCode: String,
    expiresAt: Date,
  },
  expiresAt: { type: Date },
  // 问询终态：null = 仍待处理；expired = 超时未响应；failed = 链路不支持
  resolution: { type: String, enum: ['accepted', 'declined', 'cancelled', 'expired', 'failed'] },
  resolvedAt: { type: Date },
}, { timestamps: true });

todoItemSchema.index({ userId: 1, isRead: 1 });
todoItemSchema.index({ userId: 1, createdAt: -1 });
// 终态写入/去重按 requestId 定位（含 userId + resolution 条件），避免全集合扫描
todoItemSchema.index({ 'elicitationData.requestId': 1 });
// harness 登录引导终态收敛/幂等 upsert 按 requestId 定位（迁移 009 显式创建）
todoItemSchema.index({ 'harnessLoginData.requestId': 1 });
todoItemSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const TodoItem = mongoose.model('TodoItem', todoItemSchema);
export type ITodoItem = mongoose.InferSchemaType<typeof todoItemSchema>;
