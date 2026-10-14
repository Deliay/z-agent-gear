import mongoose from 'mongoose';

const baseImageSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true, trim: true },
  description: { type: String },
  dockerfile: { type: String, required: true },
}, { collection: 'base_images', timestamps: true });

export const BaseImage = mongoose.model('BaseImage', baseImageSchema);
export type IBaseImage = mongoose.InferSchemaType<typeof baseImageSchema>;
