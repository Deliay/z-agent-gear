import mongoose from 'mongoose';

const { Schema } = mongoose;

const todoItemSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type: { type: String, enum: ['permission_request'], required: true },
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
  },
  expiresAt: { type: Date },
}, { timestamps: true });

todoItemSchema.index({ userId: 1, isRead: 1 });
todoItemSchema.index({ userId: 1, createdAt: -1 });
todoItemSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const TodoItem = mongoose.model('TodoItem', todoItemSchema);
export type ITodoItem = mongoose.InferSchemaType<typeof todoItemSchema>;
