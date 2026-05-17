import mongoose from 'mongoose';

const encryptedCredentialSchema = new mongoose.Schema({
  iv: { type: String, required: true },
  ciphertext: { type: String, required: true },
  tag: { type: String, required: true },
}, { _id: false });

const providerSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true, trim: true },
  type: { type: String, required: true, enum: ['OpenAI', 'Anthropic'] },
  endpoint: { type: String, required: true },
  credentialType: { type: String, default: 'api_key', enum: ['api_key'] },
  encryptedCredential: { type: encryptedCredentialSchema, required: true },
  isEnabled: { type: Boolean, default: true },
}, { timestamps: true });

export const Provider = mongoose.model('Provider', providerSchema);
export type IProvider = mongoose.InferSchemaType<typeof providerSchema>;
