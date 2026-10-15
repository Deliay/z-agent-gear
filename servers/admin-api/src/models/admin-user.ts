import mongoose from 'mongoose';

const adminUserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true },
  passwordHash: { type: String, required: true },
  mustChangePassword: { type: Boolean, default: true },
  // 最近一次改密时间；JWT 签发时记录该值，改密后旧 token 立即失效（问题 6）
  passwordChangedAt: { type: Date, default: null },
}, { collection: 'admin_users', timestamps: true });

export const AdminUser = mongoose.model('AdminUser', adminUserSchema);
export type IAdminUser = mongoose.InferSchemaType<typeof adminUserSchema>;
