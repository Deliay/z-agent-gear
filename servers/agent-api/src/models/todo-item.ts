import mongoose from 'mongoose';

const { Schema } = mongoose;

const todoItemSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type: { type: String, enum: ['permission_request', 'elicitation_request', 'workflow_intervention'], required: true },
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
  expiresAt: { type: Date },
}, { timestamps: true });

todoItemSchema.index({ userId: 1, isRead: 1 });
todoItemSchema.index({ userId: 1, createdAt: -1 });
todoItemSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const TodoItem = mongoose.model('TodoItem', todoItemSchema);
export type ITodoItem = mongoose.InferSchemaType<typeof todoItemSchema>;
