import mongoose from 'mongoose';

const adminUserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true },
  passwordHash: { type: String, required: true },
  mustChangePassword: { type: Boolean, default: true },
}, { collection: 'admin_users', timestamps: true });

export const AdminUser = mongoose.model('AdminUser', adminUserSchema);
export type IAdminUser = mongoose.InferSchemaType<typeof adminUserSchema>;
