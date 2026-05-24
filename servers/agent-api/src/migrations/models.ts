import mongoose from 'mongoose';

const migrationsSchema = new mongoose.Schema({
  name: { type: String, unique: true, sparse: true },
  executedAt: { type: Date },
  _lock: { type: String, sparse: true },
  acquired: { type: Date },
  expiresAt: { type: Date },
});

export const Migrations = mongoose.model('Migrations', migrationsSchema);
