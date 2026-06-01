import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { McpProxyKey, IMcpProxyKey } from '../models/mcp-proxy-key.js';

const SALT_ROUNDS = 10;

export class McpProxyKeyService {
  async createKey(userId: string, name: string): Promise<{ key: IMcpProxyKey; rawKey: string }> {
    const rawKey = `mcp_${crypto.randomBytes(24).toString('hex')}`;
    const keyHash = await bcrypt.hash(rawKey, SALT_ROUNDS);
    const keyPrefix = `${rawKey.slice(0, 7)}...${rawKey.slice(-4)}`;

    const key = await McpProxyKey.create({
      userId,
      name,
      keyHash,
      keyPrefix,
      status: 'active',
    });

    return { key, rawKey };
  }

  async verifyKey(rawKey: string): Promise<{ valid: boolean; keyId?: string; userId?: string }> {
    const keys = await McpProxyKey.find({ status: 'active' });
    for (const key of keys) {
      const match = await bcrypt.compare(rawKey, key.keyHash);
      if (match) {
        await McpProxyKey.findByIdAndUpdate(key._id, { lastUsedAt: new Date() });
        return { valid: true, keyId: key._id.toString(), userId: key.userId };
      }
    }
    return { valid: false };
  }

  async revokeKey(userId: string, keyId: string): Promise<boolean> {
    const result = await McpProxyKey.findOneAndUpdate(
      { _id: keyId, userId },
      { status: 'revoked' },
    );
    return !!result;
  }

  async listKeys(userId: string): Promise<IMcpProxyKey[]> {
    return McpProxyKey.find({ userId }).sort({ createdAt: -1 });
  }
}
