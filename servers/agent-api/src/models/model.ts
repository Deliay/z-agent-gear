import mongoose from 'mongoose';

const modelSchema = new mongoose.Schema({
  providerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Provider', required: true, index: true },
  name: { type: String, required: true },
  isCustom: { type: Boolean, default: false },
  isEnabled: { type: Boolean, default: true },
  sortOrder: { type: Number, default: 0 },
}, { timestamps: true });

modelSchema.index({ providerId: 1, name: 1 }, { unique: true });

export const Model = mongoose.model('Model', modelSchema);
export type IModel = mongoose.InferSchemaType<typeof modelSchema>;
