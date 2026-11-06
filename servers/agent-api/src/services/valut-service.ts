import mongoose from 'mongoose';
import { ValutEntry } from '../models/valut-entry.js';
import { ValutNamespace } from '../models/valut-namespace.js';
import { ValutRef } from '../models/valut-ref.js';
import { decrypt, encrypt, type EncryptedData } from './crypto.js';
import {
  assertWorkspaceWritable,
  getWorkspaceContext,
  type WorkspaceContext,
} from './workspace-context.js';

/**
 * Valut 工作区密钥管理**唯一读写口**（MCP+Valut 功能迭代 / 提案 §3.2、计划 Phase 1）。
 *
 * 安全红线（实现期不得回退）：
 * - 明文不出服务端：`encrypt` 仅在 `createManualEntry` / `createManagedEntry` / `updateValue`
 *   内调用；解密仅 `resolveValue`（服务端内部，本期唯一消费点 = custom-mcp-forwarder），
 *   **不被任何 GraphQL resolver 引用**；
 * - 所有 list/get 装配（`mapEntry`）显式不含 `valueEncrypted`；
 * - 本文件不记录任何 value/newToken 日志字段（REDACT_PATHS 精确路径为兜底）。
 *
 * 权限口径（复用 workspaceAccess / workspace-scope，零新机制）：
 * - 读：`applyWorkspaceScope` 独占型可见集（当前工作区）；
 * - 写：每个变更方法入口 `assertWorkspaceWritable`（全局工作区 developer →
 *   `global workspace is read-only`）+ 插件写过滤/只读拦截兜底；
 * - **无工作区上下文即抛 `workspace not found`（租户隔离红线）**：`applyWorkspaceScope`
 *   在无 ALS store 时静默不注入可见集过滤（workspace-scope.ts），因此 `listGrouped` /
 *   `updateValue` / `deleteEntry` / `deleteEntryCascade` 入口必须先 `requireContext()`
 *   （范式同 cloud-storage-service.requireContext），否则退化为全租户读写；
 *   反之 `resolveValue` / `inspectEntry` / `loadEntryNamespaces` 等**内部原语保留无上下文能力**
 *   （custom-mcp-forwarder 转发链路以 `runWithWorkspace(undefined, …)` 显式调用）；
 * - 跨工作区 id → `Not found`（存在性探针区分：确实不存在 → `valut entry not found`）；
 * - `listManualOptions` 服务层强制 `workspaceId=当前工作区`（防跨工作区 id 猜测）。
 *
 * 校验文案（契约白名单，逐字）：`valut entry not found` / `valut key already exists` /
 * `invalid valut key` / `invalid valut value` / `valut entry is not editable` /
 * `valut entry is not deletable` / `valut entry has refs`。
 */

type Doc = Record<string, unknown>;

export const MANUAL_NAMESPACE = 'manual';
export const MANUAL_DISPLAY_NAME = '自定义密钥';
const SERVICE_NAMESPACE_PREFIX = 'service-';

const KEY_MIN_LENGTH = 1;
const KEY_MAX_LENGTH = 128;
const VALUE_MIN_LENGTH = 1;
const VALUE_MAX_LENGTH = 16384;
/** key 禁空白（\s 含 \t\n\r 等）与控制字符（\p{Cc}）。 */
const KEY_FORBIDDEN = /[\s\p{Cc}]/u;

export interface ValutRefView {
  feature: string;
  refId: string;
  refLabel: string | null;
  createdAt: string;
}

export interface ValutEntryView {
  id: string;
  namespace: string;
  namespaceDisplayName: string;
  key: string;
  editable: boolean;
  deletable: boolean;
  refs: ValutRefView[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ValutNamespaceView {
  name: string;
  displayName: string;
  managed: boolean;
}

export interface ValutNamespaceGroupView {
  namespace: ValutNamespaceView;
  entries: ValutEntryView[];
}

export interface CreateManagedEntryParams {
  feature: string;
  refId: string;
  refLabel: string;
  key: string;
  value: string;
  editable?: boolean;
  deletable?: boolean;
  workspaceId: string;
  tenantId: string;
  createdBy: string;
}

function str(value: unknown): string {
  return String(value);
}

function iso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  return date.toISOString();
}

function validateKey(raw: unknown): string {
  const key = typeof raw === 'string' ? raw.trim() : '';
  if (key.length < KEY_MIN_LENGTH || key.length > KEY_MAX_LENGTH || KEY_FORBIDDEN.test(key)) {
    throw new Error('invalid valut key');
  }
  return key;
}

function validateValue(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length < VALUE_MIN_LENGTH || raw.length > VALUE_MAX_LENGTH) {
    throw new Error('invalid valut value');
  }
  return raw;
}

function isDuplicateKeyError(err: unknown): boolean {
  if (err && typeof err === 'object' && (err as { code?: number }).code === 11000) return true;
  return err instanceof Error && /E11000|duplicate key/i.test(err.message);
}

function mapWriteError(err: unknown): Error {
  return isDuplicateKeyError(err) ? new Error('valut key already exists') : (err as Error);
}

/** `mcp-bearer-tokens` → `service-mcp-bearer-tokens`（已带前缀则不重复叠加）。 */
function namespaceForFeature(feature: string): string {
  const trimmed = feature.trim();
  return trimmed.startsWith(SERVICE_NAMESPACE_PREFIX) ? trimmed : `${SERVICE_NAMESPACE_PREFIX}${trimmed}`;
}

function mapRef(ref: Doc): ValutRefView {
  return {
    feature: str(ref.feature),
    refId: str(ref.refId),
    refLabel: ref.refLabel === null || ref.refLabel === undefined ? null : str(ref.refLabel),
    createdAt: iso(ref.createdAt),
  };
}

/** 视图装配（唯一出参口径）：显式不含 `valueEncrypted`。 */
function mapEntry(entry: Doc, namespaceDisplayName: string, refs: Doc[]): ValutEntryView {
  return {
    id: str(entry._id),
    namespace: str(entry.namespace),
    namespaceDisplayName,
    key: str(entry.key),
    editable: entry.editable !== false,
    deletable: entry.deletable !== false,
    refs: refs.map(mapRef),
    createdBy: str(entry.createdBy),
    createdAt: iso(entry.createdAt),
    updatedAt: iso(entry.updatedAt),
  };
}

function mapNamespace(doc: Doc): ValutNamespaceView {
  return {
    name: str(doc.name),
    displayName: str(doc.displayName),
    managed: doc.managed === true,
  };
}

export class ValutService {
  /**
   * 工作区上下文守卫（租户隔离红线，返工 MAJOR-1）：无 ALS 上下文**一律拒绝**，
   * 文案与既有服务口径一致（`cloud-storage-service.requireContext` / `middleware/auth`
   * 同为 `workspace not found`）。写/列表入口必须先过此守卫——否则 `applyWorkspaceScope`
   * 不注入可见集过滤，`ValutEntry.find({})` 等会退化为全租户扫描。
   *
   * **不适用于**内部原语（`resolveValue` / `inspectEntry` / `loadEntryNamespaces` /
   * `listManualOptions`）：转发链路（custom-mcp-forwarder）与派生查询依赖其无上下文能力。
   */
  private requireContext(): WorkspaceContext {
    const context = getWorkspaceContext();
    if (!context) throw new Error('workspace not found');
    return context;
  }

  /**
   * 功能点 namespace 注册器（D13）：幂等 upsert `service-{feature}`（managed=true，
   * `$setOnInsert` 不覆盖存量行）。启动序列在迁移完成后调用，失败仅告警不阻塞就绪。
   */
  async ensureNamespace(feature: string, displayName?: string): Promise<ValutNamespaceView> {
    const trimmed = typeof feature === 'string' ? feature.trim() : '';
    if (!trimmed) throw new Error('valut feature is required');
    const name = namespaceForFeature(trimmed);
    const doc = {
      name,
      displayName: (typeof displayName === 'string' && displayName.trim()) || trimmed,
      managed: true,
    };
    await ValutNamespace.updateOne({ name }, { $setOnInsert: doc }, { upsert: true });
    return doc;
  }

  /**
   * 当前工作区条目按 namespace 聚合（契约 `valutEntries`）。
   * refs 反查 `{valutEntryId:{$in:[...]}}` **一次查询**装配（避免 N+1）；
   * 无工作区上下文 → `workspace not found`（不静默退化为全租户扫描）。
   */
  async listGrouped(): Promise<ValutNamespaceGroupView[]> {
    this.requireContext();
    const entries = (await ValutEntry.find({})
      .sort({ createdAt: 1, _id: 1 })
      .lean()) as unknown as Doc[];

    const namespaceNames = [...new Set(entries.map((entry) => str(entry.namespace)))];
    const namespaces = namespaceNames.length
      ? ((await ValutNamespace.find({ name: { $in: namespaceNames } }).lean()) as unknown as Doc[])
      : [];
    const namespaceByName = new Map(namespaces.map((doc) => [str(doc.name), doc]));
    const refsByEntry = await this.loadRefsByEntry(entries.map((entry) => entry._id));

    const groups = new Map<string, ValutNamespaceGroupView>();
    for (const entry of entries) {
      const name = str(entry.namespace);
      const namespaceDoc = namespaceByName.get(name);
      const namespace: ValutNamespaceView = namespaceDoc
        ? mapNamespace(namespaceDoc)
        : { name, displayName: name, managed: name.startsWith(SERVICE_NAMESPACE_PREFIX) };
      let group = groups.get(name);
      if (!group) {
        group = { namespace, entries: [] };
        groups.set(name, group);
      }
      group.entries.push(
        mapEntry(entry, namespace.displayName, refsByEntry.get(str(entry._id)) ?? []),
      );
    }

    // manual（非托管）在前，service-* 按名称排序
    return [...groups.values()].sort(
      (a, b) =>
        Number(a.namespace.managed) - Number(b.namespace.managed) ||
        a.namespace.name.localeCompare(b.namespace.name),
    );
  }

  /**
   * 「选择已存在 secret」候选（契约 `valutManualOptions`）：仅 manual、
   * **服务层强制 workspaceId=当前工作区**（防跨工作区 id 猜测）；无工作区上下文返回空集。
   */
  async listManualOptions(): Promise<ValutEntryView[]> {
    const context = getWorkspaceContext();
    if (!context) return [];

    const entries = (await ValutEntry.find({
      namespace: MANUAL_NAMESPACE,
      workspaceId: context.id,
    })
      .sort({ createdAt: 1, _id: 1 })
      .lean()) as unknown as Doc[];
    if (!entries.length) return [];

    const namespace = (await ValutNamespace.findOne({ name: MANUAL_NAMESPACE }).lean()) as Doc | null;
    const displayName = namespace ? str(namespace.displayName) : MANUAL_DISPLAY_NAME;
    const refsByEntry = await this.loadRefsByEntry(entries.map((entry) => entry._id));
    return entries.map((entry) =>
      mapEntry(entry, displayName, refsByEntry.get(str(entry._id)) ?? []),
    );
  }

  /** 手动条目创建（namespace 恒 manual，加密落库）。 */
  async createManualEntry(params: {
    key: string;
    value: string;
    createdBy: string;
  }): Promise<ValutEntryView> {
    const context = this.requireContext();
    assertWorkspaceWritable(context);

    const key = validateKey(params.key);
    const value = validateValue(params.value);

    const namespace = (await ValutNamespace.findOne({ name: MANUAL_NAMESPACE }).lean()) as Doc | null;
    if (!namespace) throw new Error('valut namespace not found');
    await this.assertKeyAvailable(context.id, MANUAL_NAMESPACE, key);

    const entry = new ValutEntry({
      tenantId: context.tenantId,
      workspaceId: context.id,
      namespace: MANUAL_NAMESPACE,
      key,
      valueEncrypted: encrypt(value),
      editable: true,
      deletable: true,
      createdBy: params.createdBy,
    });
    try {
      await entry.save();
    } catch (err) {
      throw mapWriteError(err);
    }
    return this.loadView(String(entry._id));
  }

  /** 仅重写 value（key 不可改，D7）；`editable=false` 拒绝；无上下文 → `workspace not found`。 */
  async updateValue(id: string, value: string): Promise<ValutEntryView> {
    // 先过上下文守卫（无 ALS 上下文即抛），再做只读拦截
    assertWorkspaceWritable(this.requireContext());
    const next = validateValue(value);
    const entry = await this.loadEntry(id);
    if (entry.editable === false) throw new Error('valut entry is not editable');

    try {
      await ValutEntry.updateOne(
        { _id: entry._id },
        { $set: { valueEncrypted: encrypt(next) } },
      );
    } catch (err) {
      throw mapWriteError(err);
    }
    return this.loadView(str(entry._id));
  }

  /**
   * 删除条目（契约 `deleteValutEntry`）：`deletable=false` 拒绝；
   * manual 条目存在 refs 拒绝（D8，防误删导致运行期失凭据）；其余同时清理 refs；
   * 无工作区上下文 → `workspace not found`（不误删他租户条目）。
   */
  async deleteEntry(id: string): Promise<boolean> {
    assertWorkspaceWritable(this.requireContext());
    const entry = await this.loadEntry(id);
    if (entry.deletable === false) throw new Error('valut entry is not deletable');
    if (str(entry.namespace) === MANUAL_NAMESPACE) {
      const refs = await ValutRef.countDocuments({
        valutEntryId: entry._id as mongoose.Types.ObjectId,
      });
      if (refs > 0) throw new Error('valut entry has refs');
    }
    await ValutRef.deleteMany({ valutEntryId: entry._id as mongoose.Types.ObjectId });
    const result = await ValutEntry.deleteOne({ _id: entry._id });
    return result.deletedCount === 1;
  }

  /**
   * 托管写入唯一入口（提案 §3.2）：缺 ref 参数直接抛错（编码期防漏）；
   * 顺序写 entry → ref，ref 失败**补偿删除 entry**（D14，不引入事务）。
   */
  async createManagedEntry(params: CreateManagedEntryParams): Promise<ValutEntryView> {
    if (!params.feature?.trim() || !params.refId?.trim() || !params.refLabel?.trim()) {
      throw new Error('valut ref is required');
    }
    assertWorkspaceWritable(getWorkspaceContext());

    const key = validateKey(params.key);
    const value = validateValue(params.value);

    const feature = params.feature.trim();
    const namespaceName = namespaceForFeature(feature);
    const namespace = (await ValutNamespace.findOne({ name: namespaceName }).lean()) as Doc | null;
    if (!namespace) throw new Error('valut namespace not found');
    if (!params.workspaceId) throw new Error('valut workspace context is required');
    await this.assertKeyAvailable(params.workspaceId, namespaceName, key);

    const entry = new ValutEntry({
      tenantId: params.tenantId,
      workspaceId: params.workspaceId,
      namespace: namespaceName,
      key,
      valueEncrypted: encrypt(value),
      editable: params.editable ?? true,
      deletable: params.deletable ?? true,
      createdBy: params.createdBy,
    });
    try {
      await entry.save();
    } catch (err) {
      throw mapWriteError(err);
    }

    try {
      await ValutRef.create({
        valutEntryId: entry._id,
        feature,
        refId: params.refId.trim(),
        refLabel: params.refLabel.trim(),
        tenantId: params.tenantId,
        workspaceId: params.workspaceId,
      });
    } catch (err) {
      // D14 补偿：ref 写入失败即删除已写 entry，避免孤儿
      await ValutEntry.deleteOne({ _id: entry._id }).catch(() => undefined);
      if (isDuplicateKeyError(err)) throw new Error('valut ref already exists');
      throw err;
    }

    return this.loadView(String(entry._id));
  }

  /**
   * 解密取明文：**仅服务端内部**（本期唯一消费点 = custom-mcp-forwarder 内存请求头组装）；
   * 不暴露 GraphQL/REST，不被任何 resolver 引用。
   */
  async resolveValue(id: string): Promise<string> {
    const entry = await this.loadEntry(id);
    return decrypt(entry.valueEncrypted as EncryptedData);
  }

  /**
   * 条目元数据读取原语（Phase 2 custom-mcp-service：引用校验 / 删除级联 namespace 判定）。
   * 可见性与 `loadEntry` 同口径（跨工作区 `Not found`、不存在 `valut entry not found`）；
   * 仅返回 `{id, namespace, workspaceId}`——**不含 `valueEncrypted`**（明文边界）。
   */
  async inspectEntry(
    id: string,
  ): Promise<{ id: string; namespace: string; workspaceId: string }> {
    const entry = await this.loadEntry(id);
    return {
      id: str(entry._id),
      namespace: str(entry.namespace),
      workspaceId: str(entry.workspaceId),
    };
  }

  /**
   * 批量读条目 namespace 原语（Phase 2 `bearerEntryManaged` 派生，一次 `$in` 查询防 N+1）。
   * 仅**当前工作区可见**条目入 map；缺失/跨工作区/非法 id 静默跳过（派生为 null，不抛错）。
   */
  async loadEntryNamespaces(ids: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const valid = [...new Set((ids ?? []).filter((id) => mongoose.isValidObjectId(id)))];
    if (!valid.length) return map;
    const objectIds = valid.map((id) => new mongoose.Types.ObjectId(id));
    const rows = (await ValutEntry.find({ _id: { $in: objectIds } })
      .select('namespace')
      .lean()) as unknown as Doc[];
    for (const row of rows) map.set(str(row._id), str(row.namespace));
    return map;
  }

  /**
   * 最小 ref 写原语（Phase 2 bearer 引用路径「仅建 ref」）：条目可见性同 `loadEntry`，
   * `tenantId/workspaceId` 取当前上下文；namespace 判定（manual）由调用方负责
   * （custom-mcp-service）；`{feature,refId}` 唯一冲突 → `valut ref already exists`。
   */
  async createRef(params: {
    entryId: string;
    feature: string;
    refId: string;
    refLabel: string;
  }): Promise<void> {
    const context = this.requireContext();
    assertWorkspaceWritable(context);
    if (!params.feature?.trim() || !params.refId?.trim() || !params.refLabel?.trim()) {
      throw new Error('valut ref is required');
    }
    const entry = await this.loadEntry(params.entryId);
    try {
      await ValutRef.create({
        valutEntryId: entry._id as mongoose.Types.ObjectId,
        feature: params.feature.trim(),
        refId: params.refId.trim(),
        refLabel: params.refLabel.trim(),
        tenantId: context.tenantId,
        workspaceId: context.id,
      });
    } catch (err) {
      if (isDuplicateKeyError(err)) throw new Error('valut ref already exists');
      throw err;
    }
  }

  /** 删除联动原语：按 feature+refId 解除引用（换绑=先删后建）。 */
  async removeRef(feature: string, refId: string): Promise<boolean> {
    assertWorkspaceWritable(getWorkspaceContext());
    const result = await ValutRef.deleteOne({ feature, refId });
    return result.deletedCount === 1;
  }

  /** 删除联动原语：强制级联删除 entry + 其 refs（忽略 deletable，供自建 token 级联）；无上下文 → `workspace not found`。 */
  async deleteEntryCascade(id: string): Promise<boolean> {
    assertWorkspaceWritable(this.requireContext());
    let entry: Doc;
    try {
      entry = await this.loadEntry(id);
    } catch (err) {
      // 已不存在 → 幂等返回 false（跨工作区 `Not found` 仍上抛）
      if (err instanceof Error && err.message === 'valut entry not found') return false;
      throw err;
    }
    await ValutRef.deleteMany({ valutEntryId: entry._id as mongoose.Types.ObjectId });
    const result = await ValutEntry.deleteOne({ _id: entry._id });
    return result.deletedCount === 1;
  }

  /** 单条目视图（含 refs），供 mutation 返回值装配。 */
  async loadView(id: string): Promise<ValutEntryView> {
    const entry = await this.loadEntry(id);
    const namespace = (await ValutNamespace.findOne({ name: str(entry.namespace) }).lean()) as
      | Doc
      | null;
    const displayName = namespace ? str(namespace.displayName) : str(entry.namespace);
    const refsByEntry = await this.loadRefsByEntry([entry._id]);
    return mapEntry(entry, displayName, refsByEntry.get(str(entry._id)) ?? []);
  }

  /**
   * 按 id 载入条目（受工作区可见集约束）：
   * - 非法 id / 不存在 → `valut entry not found`；
   * - 存在但不在当前工作区 → `Not found`（不泄露位置，契约跨工作区口径）。
   */
  private async loadEntry(id: string): Promise<Doc> {
    if (!mongoose.isValidObjectId(id)) throw new Error('valut entry not found');
    const entry = (await ValutEntry.findOne({ _id: id }).lean()) as Doc | null;
    if (entry) return entry;
    // 存在性探针：原始驱动绕过 scope 插件，仅取 _id（不读 valueEncrypted）
    const foreign = await mongoose.connection
      .collection('valutentries')
      .findOne({ _id: new mongoose.Types.ObjectId(id) }, { projection: { _id: 1 } });
    if (foreign) throw new Error('Not found');
    throw new Error('valut entry not found');
  }

  /** refs 批量反查（一次 `$in` 查询，按 entry 聚合）。 */
  private async loadRefsByEntry(ids: unknown[]): Promise<Map<string, Doc[]>> {
    const map = new Map<string, Doc[]>();
    if (!ids.length) return map;
    const refs = (await ValutRef.find({
      valutEntryId: { $in: ids as mongoose.Types.ObjectId[] },
    })
      .sort({ createdAt: 1, _id: 1 })
      .lean()) as unknown as Doc[];
    for (const ref of refs) {
      const key = str(ref.valutEntryId);
      const list = map.get(key) ?? [];
      list.push(ref);
      map.set(key, list);
    }
    return map;
  }

  private async assertKeyAvailable(
    workspaceId: string,
    namespace: string,
    key: string,
  ): Promise<void> {
    const existing = await ValutEntry.findOne({ workspaceId, namespace, key }).lean();
    if (existing) throw new Error('valut key already exists');
  }
}

export const valutService = new ValutService();
