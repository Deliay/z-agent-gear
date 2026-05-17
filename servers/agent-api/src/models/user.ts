import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, minlength: 2, maxlength: 20 },
  passwordHash: { type: String, required: true },
}, { timestamps: true });

export const User = mongoose.model('User', userSchema);
export type IUser = mongoose.InferSchemaType<typeof userSchema>;
