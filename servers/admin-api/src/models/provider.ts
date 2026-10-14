import mongoose from 'mongoose';

// 与 servers/agent-api/src/models/provider.ts 同步演进
const encryptedCredentialSchema = new mongoose.Schema({
  iv: { type: String, required: true },
  ciphertext: { type: String, required: true },
  tag: { type: String, required: true },
}, { _id: false });

const providerSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  type: { type: String, required: true, enum: ['OpenAI', 'Anthropic'] },
  endpoint: { type: String, required: true },
  credentialType: { type: String, default: 'api_key', enum: ['api_key'] },
  encryptedCredential: { type: encryptedCredentialSchema, required: true },
  isEnabled: { type: Boolean, default: true },
  scope: { type: String, enum: ['user', 'global'], default: 'user', index: true },
}, { timestamps: true });

// 同 scope 内唯一（user 与 global 可同名并存）
providerSchema.index({ scope: 1, name: 1 }, { unique: true });

export const Provider = mongoose.model('Provider', providerSchema);
export type IProvider = mongoose.InferSchemaType<typeof providerSchema>;
