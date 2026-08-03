import mongoose from 'mongoose';

const acpMessageSchema = new mongoose.Schema({
  sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Session', required: true, index: true },
  direction: { type: String, enum: ['input', 'output'], required: true },
  type: { type: String, enum: ['text', 'image', 'tool_call', 'tool_result', 'plan', 'error'], required: true },
  content: { type: mongoose.Schema.Types.Mixed, required: true },
  metadata: { type: mongoose.Schema.Types.Mixed },
  messageId: { type: String, index: true },
}, { timestamps: true });

acpMessageSchema.index({ sessionId: 1, createdAt: 1 });
acpMessageSchema.index({ sessionId: 1, messageId: 1 });

export const AcpMessage = mongoose.model('AcpMessage', acpMessageSchema);
export type IAcpMessage = mongoose.InferSchemaType<typeof acpMessageSchema>;