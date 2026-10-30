import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { config } from '../config/index.js';
import { Controller } from '../models/controller.js';
import { CloudHost } from '../models/cloud-host.js';
import { CloudHostGithubBinding } from '../models/cloud-host-github-binding.js';
import { cloudHostService } from '../services/cloud-host-service.js';
import { githubService } from '../services/github.js';
import { commitSettingsService } from '../services/commit-settings-service.js';
import { lookupKey } from '../services/key-cache.js';

function authorized(req: Request): boolean {
  if (!config.internalApiToken) return false;
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const expected = Buffer.from(`Bearer ${config.internalApiToken}`);
  const actual = Buffer.from(header);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/**
 * cloud-controller → agent-api 内部回调：
 * - POST /internal/cloud-hosts/:id/ready
 * - POST /internal/cloud-hosts/:id/terminal
 *
 * Bearer INTERNAL_API_TOKEN；幂等；未知/非 harness 云电脑返回 404。
 */
export const internalCloudHostRouter = Router();

interface CredentialAuthResult {
  ok: boolean;
  status?: number;
  error?: string;
  controllerId?: string;
  userId?: string;
  /** 鉴权主体所属租户（云电脑/绑定查询的显式隔离维度；团队租户 tenantId != userId）。 */
  tenantId?: string;
}

function timingSafeEquals(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * 凭据接口双鉴权：`INTERNAL_API_TOKEN`（服务间）或 Controller key（容器内凭据管理器）。
 * 任何分支都不得记录 raw key/token。
 */
async function authenticateCredentialRequest(
  req: Request,
  controllerId: string,
): Promise<CredentialAuthResult> {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    return { ok: false, status: 401, error: 'UNAUTHORIZED' };
  }
  const credential = header.slice('Bearer '.length).trim();
  if (!credential) return { ok: false, status: 401, error: 'UNAUTHORIZED' };

  if (config.internalApiToken && timingSafeEquals(credential, config.internalApiToken)) {
    const host = await cloudHostService.findRawHostByController(controllerId);
    if (!host) return { ok: false, status: 404, error: 'NOT_FOUND' };
    // 租户维度以预先创建的 Controller 为准（controllerId === Controller._id）；
    // 历史/异常数据缺 Controller 时回退 host.tenantId，避免退化成无隔离条件。
    const controller = await Controller.findById(controllerId).lean();
    const tenantId = controller?.tenantId
      ? String(controller.tenantId)
      : host.tenantId
        ? String(host.tenantId)
        : undefined;
    return {
      ok: true,
      controllerId,
      userId: String(host.userId),
      tenantId,
    };
  }

  const cached = await lookupKey(credential).catch(() => null);
  if (!cached) return { ok: false, status: 401, error: 'UNAUTHORIZED' };
  const matches = await bcrypt.compare(credential, cached.keyHash).catch(() => false);
  if (!matches) return { ok: false, status: 401, error: 'UNAUTHORIZED' };
  if (cached.type !== 'cloud') return { ok: false, status: 403, error: 'FORBIDDEN' };

  const controller = await Controller.findOne({ keyId: cached.keyId }).lean();
  if (!controller || String(controller._id) !== controllerId) {
    return { ok: false, status: 403, error: 'FORBIDDEN' };
  }
  return {
    ok: true,
    controllerId,
    userId: String(cached.userId),
    tenantId: controller.tenantId ? String(controller.tenantId) : undefined,
  };
}

/**
 * 容器凭据契约要求的最小剩余有效期：agent-gear 的 `REFRESH_INTERVAL_MS`（50 分钟续期间隔）
 * + `EXPIRY_SKEW_MS`（到期前 10 分钟余量）= 60 分钟，而 GitHub App 新签发的 installation token
 * 约 60 分钟有效，故取 55 分钟作为安全下限（留 5 分钟时钟偏差余量）。
 * 低于该值的缓存 token 不得交给容器续期（否则容器拿到近过期凭据后出现凭据空窗）。
 */
export const CONTAINER_CREDENTIAL_MIN_REMAINING_MS = 55 * 60 * 1000;

/**
 * 容器凭据管理器申请本机绑定仓库的最小化 Github token。
 * 不做任何日志输出；错误只返回枚举码。
 */
internalCloudHostRouter.post(
  '/:controllerId/github-credential',
  async (req: Request, res: Response) => {
    try {
      const controllerId = String(req.params.controllerId);
      if (!mongoose.isValidObjectId(controllerId)) {
        res.status(404).json({ error: 'NOT_FOUND' });
        return;
      }
      const auth = await authenticateCredentialRequest(req, controllerId);
      if (!auth.ok) {
        res.status(auth.status ?? 401).json({ error: auth.error ?? 'UNAUTHORIZED' });
        return;
      }

      // 显式双条件：controllerId + tenantId。
      // 不能再用 userId：多租户二期团队租户 tenantId != userId，且 binding.userId 是
      // Git 设置发起者，可能不是云电脑创建者/凭据申请者。
      const tenantId = auth.tenantId ?? auth.userId;
      const host = await CloudHost.findOne({
        controllerId,
        ...(tenantId ? { tenantId } : {}),
        deletedAt: null,
      }).lean();
      if (!host) {
        res.status(404).json({ error: 'NOT_FOUND' });
        return;
      }
      if (host.status !== 'RUNNING' && host.status !== 'STARTING') {
        res.status(409).json({ error: 'HOST_NOT_RUNNING' });
        return;
      }

      // 绑定以云主机为边界（controllerId 唯一索引）+ 显式租户隔离。
      const binding = await CloudHostGithubBinding.findOne({
        controllerId,
        ...(tenantId ? { tenantId } : {}),
      }).lean();
      if (!binding) {
        res.status(404).json({ error: 'NO_BINDING' });
        return;
      }

      const { token, expiresAt } = await githubService.createRepoScopedToken(
        String(binding.accountId),
        binding.repoFullName,
        { minRemainingMs: CONTAINER_CREDENTIAL_MIN_REMAINING_MS },
      );
      res.json({ token, expiresAt: expiresAt.toISOString() });
    } catch {
      res.status(502).json({ error: 'GITHUB_UNAVAILABLE' });
    }
  },
);

/**
 * 容器提交身份下发（commit-identity-manager 每 50 分钟拉取）。
 *
 * - 双鉴权与 `github-credential` 完全一致（`INTERNAL_API_TOKEN` 或本机 Controller key）；
 * - **永不 404**：任何无法下发有效身份的场景一律 `200 {"mode":"unset"}`（鉴权失败仍 401/403）；
 *   主机不存在 / 已软删同样返回 `unset`，不再解析 bot（无主机的容器不应写入身份）；
 * - **恒 bot**：有效云电脑自身的身份无视成员个人设置，恒为平台 bot（保留 `mode` 包络兼容 2.11.x）。
 */
internalCloudHostRouter.post(
  '/:controllerId/commit-identity',
  async (req: Request, res: Response) => {
    try {
      const controllerId = String(req.params.controllerId);
      const auth = await authenticateCredentialRequest(req, controllerId);
      // 服务间调用（INTERNAL_API_TOKEN）但主机不存在时鉴权函数返回 404；
      // 本端点语义为「永不 404」，继续走 resolve 得到 unset 兜底。
      if (!auth.ok && auth.status !== 404) {
        res.status(auth.status ?? 401).json({ error: auth.error ?? 'UNAUTHORIZED' });
        return;
      }

      // 未知 / 已软删主机没有可写入身份的容器：按 unset 兜底，且不解析 bot。
      // 服务间 token 路径的 404 已在鉴权阶段判定；Controller key 路径这里补一次存在性校验。
      const host = await cloudHostService.findRawHostByController(controllerId);
      if (!host) {
        res.json({ mode: 'unset' });
        return;
      }

      const identity = await commitSettingsService.resolveCloudHostIdentity();
      res.json(identity);
    } catch {
      // 任何解析异常按「未设置」兜底，不阻塞容器启动 / 周期同步。
      res.json({ mode: 'unset' });
    }
  },
);

internalCloudHostRouter.use((req: Request, res: Response, next) => {
  if (!authorized(req)) {
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return;
  }
  next();
});

async function findHarnessHost(id: string, res: Response): Promise<Record<string, unknown> | Response> {
  const host = await cloudHostService.findRawHost(id);
  if (!host || !Array.isArray(host.harnessTypes) || host.harnessTypes.length === 0) {
    return res.status(404).json({ error: 'NOT_FOUND' });
  }
  return host;
}

internalCloudHostRouter.post('/:id/ready', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const host = await findHarnessHost(id, res);
    if (host === res) return;
    const result = await cloudHostService.handleReady(id);
    res.json(result);
  } catch (err) {
    console.error('[internal-cloud-host] ready failed', (err as Error).message);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

internalCloudHostRouter.post('/:id/terminal', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const host = await findHarnessHost(id, res);
    if (host === res) return;
    const status = req.body?.status;
    if (status !== 'stopped' && status !== 'failed') {
      res.status(400).json({ error: 'INVALID_BODY' });
      return;
    }
    const result = await cloudHostService.handleTerminal(id, {
      status,
      reason: typeof req.body?.reason === 'string' ? req.body.reason : undefined,
    });
    res.json(result);
  } catch (err) {
    console.error('[internal-cloud-host] terminal failed', (err as Error).message);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});
