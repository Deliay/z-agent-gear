import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { isTerminalStatus } from '../models/cloud-container.js';
import type {
  CloudContainerEntity,
  ContainerRepository,
} from '../repositories/container-repository.js';

export const SALT_ROUNDS = 10;

/**
 * 一次性容器鉴权 token：
 *   - 格式 `<containerId>.<secret>`，secret 为 32 字节随机数的 base64url。
 *   - 仅存 secret 的 bcrypt 哈希于 `cloudcontainers.tokenHash`，绝不触碰 controllerkeys。
 *   - 校验先按 containerId 定位文档再 bcrypt 比对，避免全表扫描。
 */
export class TokenService {
  constructor(
    private readonly repo: ContainerRepository,
    private readonly saltRounds: number = SALT_ROUNDS,
  ) {}

  async issue(containerId: string): Promise<string> {
    const secret = crypto.randomBytes(32).toString('base64url');
    const tokenHash = await bcrypt.hash(secret, this.saltRounds);
    const updated = await this.repo.update(containerId, { tokenHash });
    if (!updated) {
      throw new Error(`Container not found: ${containerId}`);
    }
    return `${containerId}.${secret}`;
  }

  async verify(token: string | null | undefined): Promise<CloudContainerEntity | null> {
    if (!token || typeof token !== 'string') return null;

    const separator = token.indexOf('.');
    if (separator <= 0) return null;

    const containerId = token.slice(0, separator);
    const secret = token.slice(separator + 1);
    if (!containerId || !secret) return null;

    // 定位先行：未知 id 直接拒绝，不做任何全表扫描。
    const container = await this.repo.findById(containerId);
    if (!container) return null;
    if (!container.tokenHash) return null;
    if (isTerminalStatus(container.status)) return null;

    const valid = await bcrypt.compare(secret, container.tokenHash);
    return valid ? container : null;
  }
}
