import { GraphQLError } from 'graphql';
import mongoose from 'mongoose';
import { config } from '../config/index.js';
import { CloudHost, HARNESS_TYPES, type HarnessType } from '../models/cloud-host.js';
import { Controller } from '../models/controller.js';
import { ControllerKey } from '../models/controller-key.js';
import { ControllerWorkspace } from '../models/controller-workspace.js';
import { Session } from '../models/session.js';
import { billingClient, BillingServiceUnavailableError } from './billing-client.js';
import {
  CloudControllerClient,
  CloudControllerUnavailableError,
  cloudControllerClient,
} from './cloud-controller-client.js';
import { cloudWorkloadReader, harnessSlug, type HarnessPreset } from './cloud-workload-reader.js';
import { evictKeyById } from './key-cache.js';
import { KeyedMutex } from './keyed-mutex.js';
import { modelService } from './model.js';
import { sessionService } from './session.js';
import { controllerKeyService } from './controller-key.js';
import { controllerService } from './controller.js';
import { controllerWorkspaceService } from './controller-workspace.js';

export const CLOUD_HOST_AGENT_GEAR_MIN_VERSION = '2.5.0';

const ACTIVE_STATUSES = ['STARTING', 'RUNNING', 'STOPPING'] as const;

const HARNESS_ACP_TYPES: Record<HarnessType, string> = {
  OPENCODE: 'opencode',
};

export interface CreateCloudHostInput {
  name: string;
  harnessTypes: string[];
}

export interface CloudHostStopImpact {
  activeSessionCount: number;
  sessionsWillBeLost: boolean;
  sessions: Array<{
    id: string;
    title: string;
    status: string;
    acpServerType: string;
  }>;
}

export interface TerminalCallbackInput {
  status: 'stopped' | 'failed';
  reason?: string;
}

type Doc = Record<string, unknown>;

interface CloudHostServiceDeps {
  controllerClient?: CloudControllerClient;
  workloadReader?: typeof cloudWorkloadReader;
  maxPerUser?: number;
  ttlSeconds?: number;
}

function iso(value: unknown): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

function parseHarnessTypes(raw: string[]): HarnessType[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('at least one harness type is required');
  }
  const result: HarnessType[] = [];
  for (const value of raw) {
    if (typeof value !== 'string') {
      throw new Error(`unsupported harness type: ${String(value)}`);
    }
    const normalized = value.trim().toUpperCase();
    if (!HARNESS_TYPES.includes(normalized as HarnessType)) {
      throw new Error(`unsupported harness type: ${value.trim()}`);
    }
    if (!result.includes(normalized as HarnessType)) {
      result.push(normalized as HarnessType);
    }
  }
  if (result.length === 0) {
    throw new Error('at least one harness type is required');
  }
  return result;
}

/**
 * 前台云电脑领域服务：创建编排 / 每用户 1 实例 / 停止即销毁 / 软删除 /
 * ready+terminal 回调 / 默认会话 / 会话只读判定入口。
 */
export class CloudHostService {
  private readonly userMutex = new KeyedMutex();
  private readonly hostMutex = new KeyedMutex();
  private readonly controllerClient: CloudControllerClient;
  private readonly workloadReader: typeof cloudWorkloadReader;
  private readonly maxPerUser: number;
  private readonly ttlSeconds: number;

  constructor(deps: CloudHostServiceDeps = {}) {
    this.controllerClient = deps.controllerClient ?? cloudControllerClient;
    this.workloadReader = deps.workloadReader ?? cloudWorkloadReader;
    this.maxPerUser = deps.maxPerUser ?? config.cloudHostMaxPerUser;
    this.ttlSeconds = deps.ttlSeconds ?? config.harnessContainerTtlSeconds;
  }

  async getCapabilities(): Promise<{ enabled: boolean; supportedHarnesses: HarnessType[] }> {
    if (!config.harnessEnabled) {
      return { enabled: false, supportedHarnesses: [] };
    }
    try {
      await this.workloadReader.findHarnessPreset('OPENCODE');
      return { enabled: true, supportedHarnesses: ['OPENCODE'] };
    } catch {
      // preset 缺失：能力列表为空，create 返回明确错误
      return { enabled: true, supportedHarnesses: [] };
    }
  }

  private assertFeature(): void {
    if (!config.harnessEnabled) {
      throw new Error('harness feature is disabled');
    }
  }

  private assertConfigured(): void {
    if (
      !config.controllerApiPublicEndpoint ||
      !config.cloudHostModelBaseUrl ||
      !config.cloudControllerUrl ||
      !config.internalApiToken
    ) {
      throw new Error('cloud host is not configured');
    }
  }

  private validateInput(input: CreateCloudHostInput): {
    name: string;
    harnessTypes: HarnessType[];
  } {
    const name = (input.name ?? '').trim();
    if (!name) throw new Error('name is required');
    if (name.length > 64) throw new Error('name is too long');
    return { name, harnessTypes: parseHarnessTypes(input.harnessTypes) };
  }

  async create(userId: string, input: CreateCloudHostInput): Promise<Doc> {
    this.assertFeature();
    this.assertConfigured();
    const { name, harnessTypes } = this.validateInput(input);

    // 读取 harness preset 先于任何落库（缺失时不留下半成品记录）
    const presets: HarnessPreset[] = [];
    for (const type of harnessTypes) {
      presets.push(await this.workloadReader.findHarnessPreset(type));
    }

    return this.userMutex.runExclusive(`user:${userId}`, async () => {
      const activeCount = await CloudHost.countDocuments({
        userId,
        status: { $in: ACTIVE_STATUSES },
        deletedAt: null,
      });
      if (activeCount >= this.maxPerUser) {
        throw new Error('too many cloud hosts');
      }

      let account: { id: string };
      try {
        account = await billingClient.getAccount('front_user', userId);
      } catch {
        throw new Error('billing service unavailable');
      }

      const cloudHostId = new mongoose.Types.ObjectId().toString();
      const controllerId = new mongoose.Types.ObjectId().toString();
      const expiresAt = new Date(Date.now() + this.ttlSeconds * 1000);

      let keyId: string | null = null;
      let workspaceId: string | null = null;
      let modelKeyId: string | null = null;
      let containerStarted = false;

      try {
        const createdKey = await controllerKeyService.createForCloudHost(
          userId,
          controllerId,
          name,
        );
        keyId = String(createdKey.key.id);

        await controllerService.createCloudHostController(userId, controllerId, name, keyId);

        const workspace = await controllerWorkspaceService.ensureCloudHostWorkspace(
          controllerId,
          userId,
          config.cloudHostDefaultWorkspace,
        );
        workspaceId = String(workspace.id);

        await CloudHost.create({
          _id: cloudHostId,
          userId,
          name,
          harnessTypes,
          status: 'STARTING',
          controllerId,
          keyId,
          workspaceId,
          startedAt: new Date(),
        });

        const models = await modelService.findAll();
        const modelIds = Array.from(
          new Set(
            models
              .filter((model) => (model as { isEnabled?: boolean }).isEnabled !== false)
              .map((model) => String((model as { name?: string }).name ?? '').trim())
              .filter(Boolean),
          ),
        );

        const modelKey = await billingClient.createCloudHostApiKey({
          accountId: account.id,
          ownerType: 'front_user',
          ownerId: userId,
          name: `cloud-host:${name}`.slice(0, 64),
          cloudHostId,
          expiresAt: expiresAt.toISOString(),
        });
        modelKeyId = modelKey.apiKey.id;

        const workloadPlan = presets.map((preset) => ({
          workloadId: preset.id,
          params: {},
          implicit: false,
          required: true,
        }));

        const container = await this.controllerClient
          .startHarness({
            hostId: cloudHostId,
            controllerKeyId: keyId,
            containerApiKeyId: modelKeyId,
            userId,
            hostName: name,
            harnessTypes: harnessTypes.map((type) => harnessSlug(type)),
            expiresAt,
            billingAccountId: account.id,
            agentGearMinVersion: CLOUD_HOST_AGENT_GEAR_MIN_VERSION,
            workloadPlan,
            secrets: {
              hostEndpoint: config.controllerApiPublicEndpoint,
              hostKey: createdKey.rawKey,
              modelApiKey: modelKey.secret,
              modelBaseUrl: config.cloudHostModelBaseUrl,
              modelIds: JSON.stringify(modelIds),
              defaultWorkspace: config.cloudHostDefaultWorkspace,
            },
          })
          .catch(() => {
            // 创建/网络/响应异常统一映射为控制面不可用（契约错误文案）
            throw new CloudControllerUnavailableError();
          });
        // cloud-controller 成功返回后不再回滚（后续异常由 terminal/TTL 兜底）
        containerStarted = true;

        const updated = await CloudHost.findByIdAndUpdate(
          cloudHostId,
          { $set: { containerId: container.id } },
          { new: true },
        ).lean();
        return this.mapCloudHost(updated ?? (await CloudHost.findById(cloudHostId).lean())!, 0);
      } catch (err) {
        if (!containerStarted) {
          await this.rollback({
            userId,
            cloudHostId,
            controllerId,
            keyId,
            workspaceId,
          });
        }
        if (err instanceof CloudControllerUnavailableError) {
          throw new Error('control plane unavailable');
        }
        if (err instanceof BillingServiceUnavailableError) {
          throw new Error('billing service unavailable');
        }
        throw err;
      }
    });
  }

  /** 创建失败逆序回滚（best-effort；原始错误优先，回滚失败只记录日志）。 */
  private async rollback(input: {
    userId: string;
    cloudHostId: string;
    controllerId: string;
    keyId: string | null;
    workspaceId: string | null;
  }): Promise<void> {
    const tasks: Array<Promise<unknown>> = [
      billingClient.revokeApiKeysByHost(input.cloudHostId).catch((err) => {
        console.warn('[cloud-host] revoke model key on rollback failed:', (err as Error).message);
      }),
    ];
    if (input.workspaceId) {
      tasks.push(ControllerWorkspace.deleteOne({ _id: input.workspaceId }));
    }
    tasks.push(Controller.deleteOne({ _id: input.controllerId }));
    if (input.keyId) {
      tasks.push(evictKeyById(input.keyId));
      tasks.push(ControllerKey.deleteOne({ _id: input.keyId }));
    }
    tasks.push(CloudHost.deleteOne({ _id: input.cloudHostId }));
    await Promise.allSettled(tasks);
  }

  async list(userId: string): Promise<Doc[]> {
    const hosts = await CloudHost.find({ userId, deletedAt: null })
      .sort({ createdAt: -1 })
      .lean();
    if (hosts.length === 0) return [];
    const counts = await Promise.all(
      hosts.map((host) =>
        Session.countDocuments({
          controllerId: host.controllerId,
          userId,
          status: { $ne: 'ended' },
        }),
      ),
    );
    return hosts.map((host, index) => this.mapCloudHost(host, counts[index] ?? 0));
  }

  async stopImpact(id: string, userId: string): Promise<CloudHostStopImpact> {
    const host = await this.findOwnedHost(id, userId);
    const sessions = await Session.find({
      controllerId: String(host.controllerId),
      userId,
      status: { $ne: 'ended' },
    })
      .sort({ createdAt: -1 })
      .lean();
    return {
      activeSessionCount: sessions.length,
      sessionsWillBeLost: sessions.length > 0,
      sessions: sessions.map((session) => ({
        id: String(session._id),
        title: String(session.title ?? ''),
        status: String(session.status ?? ''),
        acpServerType: String(session.acpServerType ?? ''),
      })),
    };
  }

  async stop(id: string, userId: string, force?: boolean): Promise<Doc> {
    return this.hostMutex.runExclusive(`host:${id}`, async () => {
      const host = await this.findOwnedHost(id, userId);
      if (host.status === 'STOPPED' || host.status === 'FAILED') {
        return this.mapCloudHost(host as unknown as Doc, await this.countActive(host));
      }

      const activeCount = await this.countActive(host);
      if (activeCount > 0 && force !== true) {
        throw new Error(
          'stopping this cloud host will permanently lose all active sessions',
        );
      }

      const stopping = await CloudHost.findOneAndUpdate(
        { _id: id, userId, status: { $in: ACTIVE_STATUSES } },
        { $set: { status: 'STOPPING' } },
        { new: true },
      ).lean();
      if (!stopping) {
        const current = await this.findOwnedHost(id, userId);
        if (current.status === 'STOPPED' || current.status === 'FAILED') {
          return this.mapCloudHost(current, 0);
        }
        throw new Error('control plane unavailable');
      }

      await sessionService.endByController(String(host.controllerId), userId);

      if (host.containerId) {
        try {
          await this.controllerClient.destroyContainer(String(host.containerId));
        } catch {
          // 停止失败保持 STOPPING 可重试；会话已 ENDED 不回滚
          throw new Error('control plane unavailable');
        }
      }

      await billingClient.revokeApiKeysByHost(id).catch((err) => {
        console.warn('[cloud-host] revoke model key on stop failed:', (err as Error).message);
      });

      const stopped = await CloudHost.findOneAndUpdate(
        { _id: id, userId, status: 'STOPPING' },
        {
          $set: {
            status: 'STOPPED',
            stoppedAt: new Date(),
            containerId: null,
          },
        },
        { new: true },
      ).lean();
      const latest = stopped ?? (await this.findOwnedHost(id, userId));
      return this.mapCloudHost(latest, 0);
    });
  }

  async delete(id: string, userId: string): Promise<boolean> {
    return this.hostMutex.runExclusive(`host:${id}`, async () => {
      if (!mongoose.isValidObjectId(id)) {
        throw new Error('Cloud host not found');
      }
      const host = await CloudHost.findOne({ _id: id, userId }).lean();
      if (!host) throw new Error('Cloud host not found');
      if (host.deletedAt) return true;
      if (host.status !== 'STOPPED' && host.status !== 'FAILED') {
        throw new Error('stop the cloud host before deleting');
      }

      await billingClient.revokeApiKeysByHost(id).catch((err) => {
        console.warn('[cloud-host] revoke model key on delete failed:', (err as Error).message);
      });

      const keyId = String(host.keyId);
      try {
        await evictKeyById(keyId);
      } catch (err) {
        console.warn('[cloud-host] evict controller key failed:', (err as Error).message);
      }
      await ControllerKey.deleteOne({ _id: keyId });
      await controllerService.markCloudHostOffline(String(host.controllerId), userId);
      await CloudHost.updateOne({ _id: id }, { $set: { deletedAt: new Date() } });
      return true;
    });
  }

  /** 内部 ready 回调：STARTING→RUNNING；单 harness 自动创建默认会话（幂等，per-host 串行）。 */
  async handleReady(id: string): Promise<Doc | null> {
    return this.hostMutex.runExclusive(`host:${id}`, () => this.handleReadyLocked(id));
  }

  private async handleReadyLocked(id: string): Promise<Doc | null> {
    const host = await this.findRawHost(id);
    if (!host) return null;
    if (host.status === 'STOPPED' || host.status === 'FAILED' || host.status === 'STOPPING') {
      return this.mapCloudHost(host, await this.countActive(host));
    }

    let current = host;
    if (host.status !== 'RUNNING') {
      const updated = await CloudHost.findOneAndUpdate(
        { _id: id, deletedAt: null, status: 'STARTING' },
        { $set: { status: 'RUNNING', readyAt: new Date() } },
        { new: true },
      ).lean();
      const fetched = updated ?? (await this.findRawHost(id));
      if (!fetched) return null;
      // CAS 未命中且已被并发终止（STOPPING/STOPPED/FAILED）：不得创建默认会话
      if (fetched.status !== 'RUNNING') {
        return this.mapCloudHost(fetched, await this.countActive(fetched));
      }
      current = fetched;
    }

    const harnessTypes = (current.harnessTypes ?? []) as HarnessType[];
    if (harnessTypes.length === 1 && !current.defaultSessionId) {
      try {
        const session = await sessionService.create(String(current.userId), {
          controllerId: String(current.controllerId),
          workspaceId: String(current.workspaceId),
          acpServerType: HARNESS_ACP_TYPES[harnessTypes[0]] ?? 'opencode',
        });
        await CloudHost.updateOne(
          { _id: id, defaultSessionId: null },
          { $set: { defaultSessionId: session.id } },
        );
        current.defaultSessionId = session.id;
      } catch (err) {
        // 默认会话失败不影响云电脑可用；前端提示可手动创建
        console.warn(
          `[cloud-host] create default session failed for ${id}:`,
          (err as Error).message,
        );
      }
    }
    const refreshed = (await this.findRawHost(id)) ?? current;
    return this.mapCloudHost(refreshed, await this.countActive(refreshed));
  }

  /** 内部 terminal 回调：驱动 STOPPED/FAILED + 会话 ENDED + 撤销模型 Key（幂等）。 */
  async handleTerminal(id: string, input: TerminalCallbackInput): Promise<Doc | null> {
    const host = await this.findRawHost(id);
    if (!host) return null;
    if (host.status === 'STOPPED' || host.status === 'FAILED') {
      return this.mapCloudHost(host, 0);
    }

    const target = input.status === 'failed' ? 'FAILED' : 'STOPPED';
    const updated = await CloudHost.findOneAndUpdate(
      { _id: id, status: { $in: ACTIVE_STATUSES } },
      {
        $set: {
          status: target,
          stoppedAt: new Date(),
          containerId: null,
          failureReason: target === 'FAILED' ? input.reason ?? 'cloud host failed' : null,
        },
      },
      { new: true },
    ).lean();
    const current = updated ?? (await this.findRawHost(id));
    if (!current) return null;

    await sessionService.endByController(String(current.controllerId), String(current.userId));
    await billingClient.revokeApiKeysByHost(id).catch((err) => {
      console.warn('[cloud-host] revoke model key on terminal failed:', (err as Error).message);
    });
    return this.mapCloudHost(current, 0);
  }

  /** 内部路由用于区分「不存在」「非云电脑」。 */
  async findRawHost(id: string): Promise<Doc | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    return (await CloudHost.findOne({ _id: id, deletedAt: null }).lean()) as Doc | null;
  }

  private async findOwnedHost(id: string, userId: string): Promise<Doc> {
    if (!mongoose.isValidObjectId(id)) {
      throw new Error('Cloud host not found');
    }
    const host = await CloudHost.findOne({ _id: id, userId, deletedAt: null }).lean();
    if (!host) throw new Error('Cloud host not found');
    return host as Doc;
  }

  private async countActive(host: Doc): Promise<number> {
    return Session.countDocuments({
      controllerId: String(host.controllerId),
      userId: String(host.userId),
      status: { $ne: 'ended' },
    });
  }

  mapCloudHost(host: Doc, activeSessionCount = 0): Doc {
    return {
      id: String(host._id ?? host.id),
      name: host.name,
      controllerId: String(host.controllerId),
      status: host.status,
      harnessTypes: (host.harnessTypes ?? []) as string[],
      defaultSessionId: host.defaultSessionId ? String(host.defaultSessionId) : null,
      activeSessionCount,
      containerId: host.containerId ?? null,
      createdAt: iso(host.createdAt) ?? new Date(0).toISOString(),
      readyAt: iso(host.readyAt),
      stoppedAt: iso(host.stoppedAt),
      failureReason: host.failureReason ?? null,
      deletedAt: iso(host.deletedAt),
    };
  }
}

/** 供 resolver 统一把 service 错误转为 GraphQLError（保留逐字文案）。 */
export function toCloudHostGraphQLError(err: unknown): never {
  if (err instanceof GraphQLError) throw err;
  throw new GraphQLError(err instanceof Error ? err.message : String(err));
}

export const cloudHostService = new CloudHostService();
