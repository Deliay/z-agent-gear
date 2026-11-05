import mongoose from 'mongoose';
import { CustomMcpServer } from '../models/custom-mcp-server.js';
import { MANUAL_NAMESPACE, valutService } from './valut-service.js';
import { assertWorkspaceWritable, getWorkspaceContext } from './workspace-context.js';

/**
 * 自定义 MCP **唯一读写口**（MCP+Valut 功能迭代 Phase 2；契约 `contracts/custom-mcp.graphql`）。
 *
 * 语义（计划 Phase 2 关键实现要点 / 提案 §5.2 实现点 3/4）：
 * - **create**：校验（name/endpoint/customHeaders/auth，白名单逐字）→ `none` 直接落库；
 *   bearer+newToken → **预生成 MCP `_id` 一次成型**：落 MCP（bearerValutEntryId 暂空）→
 *   `createManagedEntry('mcp-bearer-tokens', refId=MCP id, key=name, editable=true/deletable=false)`
 *   → 回写 `bearerValutEntryId`；中途失败补偿删除 MCP（D14 同惯例）；
 *   bearer+existingEntryId → 校验条目存在/当前工作区可见/namespace=manual（否则
 *   `bearer entry must be manual namespace`）→ 落 MCP → `createRef` 仅建 ref（失败补偿删 MCP）。
 * - **update**：name/description/endpoint/customHeaders 直改（校验先行，重名预检）；
 *   `auth` 省略/null = 不动；bearer+newToken → 自建条目走 `updateValue` 内部重写值路径
 *   （不回显、不走 GraphQL），manual 引用 → `bearer entry not editable in place`（穿透编辑）；
 *   bearer+existingEntryId → **换绑 = 先删旧 ref 再建新 ref**（旧关联按删除同口径：自建旧条目
 *   `deleteEntryCascade`、manual 旧引用仅 `removeRef`），同目标幂等；bearer+none → 解绑（同口径）。
 * - **delete（D14）**：读 MCP → 判条目实际 `namespace` → 以 `_id` 删除 `deletedCount===1`
 *   为「执行级联」凭证（防双级联，输家不重复级联）→ 自建级联删 ref+entry / 引用仅删 ref。
 *   条目存在性由 entry namespace 判定，不以前端标记为准。
 * - **`bearerEntryManaged` 派生**：条目 namespace === `service-mcp-bearer-tokens` → true；
 *   `manual` → false；无条目（none/悬空）→ null。
 *
 * 权限：读走 `applyWorkspaceScope` 独占型可见集；写入口 `assertWorkspaceWritable`
 * （全局工作区 developer → `global workspace is read-only`）+ 插件写过滤兜底；
 * 跨工作区 id → `Not found`（存在性探针区分）、不存在 id → `custom mcp server not found`。
 *
 * 明文边界：本服务不记录任何 token/value 日志；出参装配（`mapServer`）显式白名单字段，
 * 视图恒不含 token；bearer token 只存于 `valutentries.valueEncrypted`（加密）。
 */

type Doc = Record<string, unknown>;

/** Valut 功能点（`valutrefs.feature`，不带 `service-` 前缀）。 */
export const MCP_BEARER_FEATURE = 'mcp-bearer-tokens';
/** 自建条目 namespace（`valut-service.ensureNamespace` 启动自检创建）。 */
const MCP_BEARER_NAMESPACE = `service-${MCP_BEARER_FEATURE}`;

const WORKSPACE_CONTEXT_REQUIRED = 'custom mcp workspace context is required';

const NAME_MIN_LENGTH = 1;
const NAME_MAX_LENGTH = 64;
const DESCRIPTION_MAX_LENGTH = 512;
const ENDPOINT_MAX_LENGTH = 1024;
const HEADER_MAX_COUNT = 32;
const HEADER_VALUE_MAX_LENGTH = 4096;
/**
 * header key：RFC7230 token 字符集**去掉 `.` 与 `$`**，并排除 Mongoose Map 保留键名——
 * Mongoose Map 存储禁点号/`$` 前缀/`constructor` 等键（否则 save 抛错），提前收敛为白名单文案。
 */
const HEADER_KEY_RE = /^[A-Za-z0-9!#%&'*+^_`|~-]+$/;
const RESERVED_MAP_KEYS = new Set(['constructor', 'prototype', '__proto__']);

export interface CustomMcpHeader {
  key: string;
  /** 同名 header 多值 */
  values: string[];
}

export interface CustomMcpServerView {
  id: string;
  name: string;
  description: string | null;
  endpoint: string;
  authType: 'none' | 'bearer';
  customHeaders: CustomMcpHeader[];
  bearerEntryId: string | null;
  /** true=自建（service-*，可就地更新）；false=引用 manual（穿透编辑）；null=无条目 */
  bearerEntryManaged: boolean | null;
  workspaceId: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CustomMcpAuthInputValue {
  type: 'none' | 'bearer';
  newToken?: string | null;
  existingEntryId?: string | null;
}

export interface CreateCustomMcpServerParams {
  name: string;
  description?: string | null;
  endpoint: string;
  auth: CustomMcpAuthInputValue;
  customHeaders?: CustomMcpHeader[] | null;
  createdBy: string;
}

export interface UpdateCustomMcpServerParams {
  name?: string | null;
  description?: string | null;
  endpoint?: string | null;
  auth?: CustomMcpAuthInputValue | null;
  customHeaders?: CustomMcpHeader[] | null;
}

interface ResolvedAuth {
  type: 'none' | 'bearer';
  token: string | null;
  existingEntryId: string | null;
}

interface McpUpdate {
  name?: string;
  description?: string | null;
  endpoint?: string;
  authType?: 'none' | 'bearer';
  bearerValutEntryId?: mongoose.Types.ObjectId | null;
  customHeaders?: Map<string, string[]>;
}

function str(value: unknown): string {
  return String(value);
}

function iso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  return date.toISOString();
}

function validateName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (name.length < NAME_MIN_LENGTH || name.length > NAME_MAX_LENGTH) {
    throw new Error('invalid mcp name');
  }
  return name;
}

function validateDescription(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string' || raw.length > DESCRIPTION_MAX_LENGTH) {
    // 契约错误表未列 description 文案（前端 maxlength 同步收敛），此处按服务层约束拒绝
    throw new Error('invalid mcp description');
  }
  const description = raw.trim();
  return description ? description : null;
}

function validateEndpoint(raw: unknown): string {
  const endpoint = typeof raw === 'string' ? raw.trim() : '';
  if (!endpoint || endpoint.length > ENDPOINT_MAX_LENGTH) {
    throw new Error('invalid mcp endpoint');
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('invalid mcp endpoint');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('invalid mcp endpoint');
  }
  return endpoint;
}

function validateHeaders(raw: unknown): CustomMcpHeader[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > HEADER_MAX_COUNT) {
    throw new Error('invalid custom headers');
  }
  const seen = new Set<string>();
  const headers: CustomMcpHeader[] = [];
  for (const item of raw as unknown[]) {
    if (!item || typeof item !== 'object') throw new Error('invalid custom headers');
    const { key: rawKey, values: rawValues } = item as { key?: unknown; values?: unknown };
    const key = typeof rawKey === 'string' ? rawKey.trim() : '';
    if (!key || !HEADER_KEY_RE.test(key) || RESERVED_MAP_KEYS.has(key) || seen.has(key)) {
      throw new Error('invalid custom headers');
    }
    if (!Array.isArray(rawValues) || rawValues.length === 0) {
      throw new Error('invalid custom headers');
    }
    const values: string[] = [];
    for (const value of rawValues as unknown[]) {
      if (typeof value !== 'string' || value.length > HEADER_VALUE_MAX_LENGTH) {
        throw new Error('invalid custom headers');
      }
      values.push(value);
    }
    seen.add(key);
    headers.push({ key, values });
  }
  return headers;
}

function toHeaderMap(headers: CustomMcpHeader[]): Map<string, string[]> {
  return new Map(headers.map((header) => [header.key, [...header.values]]));
}

function resolveAuth(auth: unknown): ResolvedAuth {
  const input = (auth ?? {}) as { type?: unknown; newToken?: unknown; existingEntryId?: unknown };
  const type = input.type;
  if (type !== 'none' && type !== 'bearer') throw new Error('invalid mcp auth type');
  const token = typeof input.newToken === 'string' && input.newToken.length > 0
    ? input.newToken
    : null;
  const existingEntryId =
    typeof input.existingEntryId === 'string' && input.existingEntryId.trim()
      ? input.existingEntryId.trim()
      : null;
  return { type, token, existingEntryId };
}

function isDuplicateKeyError(err: unknown): boolean {
  if (err && typeof err === 'object' && (err as { code?: number }).code === 11000) return true;
  return err instanceof Error && /E11000|duplicate key/i.test(err.message);
}

function mapWriteError(err: unknown): Error {
  return isDuplicateKeyError(err) ? new Error('invalid mcp name') : (err as Error);
}

/**
 * 自建条目 key = MCP name（计划 Phase 2 表格口径）：撞 key 即工作区内名称冲突
 * （改名遗留旧 key 的边缘场景）→ 按白名单 `invalid mcp name` 上报，不外泄 Valut 内部文案。
 */
function mapBearerKeyError(err: unknown): unknown {
  if (err instanceof Error && err.message === 'valut key already exists') {
    return new Error('invalid mcp name');
  }
  return err;
}

function mapHeaders(raw: unknown): CustomMcpHeader[] {
  const entries: Array<[unknown, unknown]> =
    raw instanceof Map
      ? [...raw.entries()]
      : raw && typeof raw === 'object'
        ? Object.entries(raw as Record<string, unknown>)
        : [];
  return entries.map(([key, values]) => ({
    key: str(key),
    values: Array.isArray(values) ? values.map((value) => str(value)) : [],
  }));
}

/** 视图装配（唯一出参口径）：显式白名单字段，恒不含 token/value。 */
function mapServer(doc: Doc, namespaces: Map<string, string>): CustomMcpServerView {
  const bearerEntryId = doc.bearerValutEntryId ? str(doc.bearerValutEntryId) : null;
  const namespace = bearerEntryId ? namespaces.get(bearerEntryId) : undefined;
  return {
    id: str(doc._id),
    name: str(doc.name),
    description:
      doc.description === null || doc.description === undefined ? null : str(doc.description),
    endpoint: str(doc.endpoint),
    authType: str(doc.authType) === 'bearer' ? 'bearer' : 'none',
    customHeaders: mapHeaders(doc.customHeaders),
    bearerEntryId,
    bearerEntryManaged: namespace === undefined ? null : namespace === MCP_BEARER_NAMESPACE,
    workspaceId: str(doc.workspaceId),
    createdBy: str(doc.createdBy),
    createdAt: iso(doc.createdAt),
    updatedAt: iso(doc.updatedAt),
  };
}

export class CustomMcpService {
  /** 当前工作区自定义 MCP 列表（独占型可见集）。 */
  async list(): Promise<CustomMcpServerView[]> {
    const docs = (await CustomMcpServer.find({})
      .sort({ createdAt: 1, _id: 1 })
      .lean()) as unknown as Doc[];
    return this.mapDocs(docs);
  }

  /** 单条查询：不存在 → null（契约可空出参）；跨工作区 → `Not found`。 */
  async get(id: string): Promise<CustomMcpServerView | null> {
    try {
      return await this.loadView(id);
    } catch (err) {
      if (err instanceof Error && err.message === 'custom mcp server not found') return null;
      throw err;
    }
  }

  async create(params: CreateCustomMcpServerParams): Promise<CustomMcpServerView> {
    assertWorkspaceWritable(getWorkspaceContext());
    const context = getWorkspaceContext();
    if (!context) throw new Error(WORKSPACE_CONTEXT_REQUIRED);

    // 校验顺序：name → endpoint → customHeaders → description → auth（白名单逐字）
    const name = validateName(params.name);
    const endpoint = validateEndpoint(params.endpoint);
    const customHeaders = validateHeaders(params.customHeaders);
    const description = validateDescription(params.description);
    const auth = resolveAuth(params.auth);

    const mcpId = new mongoose.Types.ObjectId();
    const doc = new CustomMcpServer({
      _id: mcpId,
      tenantId: context.tenantId,
      workspaceId: context.id,
      name,
      description,
      endpoint,
      authType: auth.type,
      customHeaders: toHeaderMap(customHeaders),
      bearerValutEntryId: null,
      createdBy: params.createdBy,
    });

    if (auth.type === 'none') {
      await this.saveNew(doc);
      return this.loadView(String(mcpId));
    }

    if (auth.token) {
      // bearer + newToken：预生成 MCP _id 一次成型——落 MCP → 建 entry+ref → 回写
      await this.saveNew(doc);
      let createdId: string;
      try {
        createdId = await this.createBearerEntry({
          mcpId: String(mcpId),
          name,
          token: auth.token,
          workspaceId: context.id,
          tenantId: context.tenantId,
          createdBy: params.createdBy,
        });
      } catch (err) {
        // D14 补偿：entry/ref 中途失败即删除已落 MCP，不留半态
        await CustomMcpServer.deleteOne({ _id: mcpId }).catch(() => undefined);
        throw err;
      }
      try {
        await CustomMcpServer.updateOne(
          { _id: mcpId },
          { $set: { bearerValutEntryId: createdId } },
        );
      } catch (err) {
        await valutService.deleteEntryCascade(createdId).catch(() => undefined);
        await CustomMcpServer.deleteOne({ _id: mcpId }).catch(() => undefined);
        throw mapWriteError(err);
      }
      return this.loadView(String(mcpId));
    }

    if (auth.existingEntryId) {
      // bearer + existingEntryId：仅建 ref（校验先行，失败不留 MCP）
      await this.assertManualEntry(auth.existingEntryId);
      doc.bearerValutEntryId = new mongoose.Types.ObjectId(auth.existingEntryId);
      await this.saveNew(doc);
      try {
        await valutService.createRef({
          entryId: auth.existingEntryId,
          feature: MCP_BEARER_FEATURE,
          refId: String(mcpId),
          refLabel: name,
        });
      } catch (err) {
        await CustomMcpServer.deleteOne({ _id: mcpId }).catch(() => undefined);
        throw err;
      }
      return this.loadView(String(mcpId));
    }

    throw new Error('bearer token is required');
  }

  async update(id: string, params: UpdateCustomMcpServerParams): Promise<CustomMcpServerView> {
    assertWorkspaceWritable(getWorkspaceContext());
    const context = getWorkspaceContext();
    if (!context) throw new Error(WORKSPACE_CONTEXT_REQUIRED);
    const mcp = await this.loadMcp(id);
    const mcpId = str(mcp._id);
    const currentName = str(mcp.name);

    const $set: McpUpdate = {};
    let name = currentName;
    if (params.name !== undefined) {
      name = validateName(params.name);
      if (name !== currentName) {
        const dup = await CustomMcpServer.findOne({ name }).lean();
        if (dup) throw new Error('invalid mcp name');
      }
      $set.name = name;
    }
    if (params.endpoint !== undefined) $set.endpoint = validateEndpoint(params.endpoint);
    if (params.description !== undefined) $set.description = validateDescription(params.description);
    if (params.customHeaders !== undefined) {
      $set.customHeaders = toHeaderMap(validateHeaders(params.customHeaders));
    }

    const currentEntryId = mcp.bearerValutEntryId ? str(mcp.bearerValutEntryId) : null;
    /** 本次 attach 新建的自建条目（updateOne 失败时补偿回收）。 */
    let attachedEntryId: string | null = null;

    const auth =
      params.auth === undefined || params.auth === null ? null : resolveAuth(params.auth);
    if (auth) {
      if (auth.type === 'none') {
        // 解绑：旧关联按删除同口径处理
        if (currentEntryId) await this.detachBearer(mcpId, currentEntryId);
        $set.authType = 'none';
        $set.bearerValutEntryId = null;
      } else if (auth.token) {
        $set.authType = 'bearer';
        if (currentEntryId) {
          // 自建 → 内部重写值（不回显、不走 GraphQL）；manual 引用 → 拒绝（穿透编辑）
          const entry = await valutService.inspectEntry(currentEntryId);
          if (entry.namespace !== MCP_BEARER_NAMESPACE) {
            throw new Error('bearer entry not editable in place');
          }
          await valutService.updateValue(currentEntryId, auth.token);
        } else {
          attachedEntryId = await this.createBearerEntry({
            mcpId,
            name,
            token: auth.token,
            workspaceId: context.id,
            tenantId: context.tenantId,
            createdBy: str(mcp.createdBy),
          });
          $set.bearerValutEntryId = new mongoose.Types.ObjectId(attachedEntryId);
        }
      } else if (auth.existingEntryId) {
        $set.authType = 'bearer';
        await this.assertManualEntry(auth.existingEntryId);
        if (auth.existingEntryId !== currentEntryId) {
          // 换绑 = 先删旧 ref 再建新 ref（旧关联按删除同口径），两方向不留孤儿
          if (currentEntryId) await this.detachBearer(mcpId, currentEntryId);
          await valutService.createRef({
            entryId: auth.existingEntryId,
            feature: MCP_BEARER_FEATURE,
            refId: mcpId,
            refLabel: name,
          });
          $set.bearerValutEntryId = new mongoose.Types.ObjectId(auth.existingEntryId);
        }
      } else {
        throw new Error('bearer token is required');
      }
    }

    if (Object.keys($set).length > 0) {
      try {
        await CustomMcpServer.updateOne({ _id: mcp._id }, { $set });
      } catch (err) {
        // 补偿：attach 新建条目在落库失败时回收（D14 同惯例）
        if (attachedEntryId) {
          await valutService.deleteEntryCascade(attachedEntryId).catch(() => undefined);
        }
        throw mapWriteError(err);
      }
    }
    return this.loadView(mcpId);
  }

  /**
   * 删除（D14）：读 MCP → 判条目实际 namespace → 以 `_id` 删除 `deletedCount===1` 为
   * 「执行级联」凭证（并发输家不重复级联）→ 自建级联删 ref+entry / 引用仅删 ref → 删 MCP。
   */
  async delete(id: string): Promise<boolean> {
    assertWorkspaceWritable(getWorkspaceContext());
    const mcp = await this.loadMcp(id);
    const mcpId = str(mcp._id);
    const entryId = mcp.bearerValutEntryId ? str(mcp.bearerValutEntryId) : null;

    // 删除前判定 namespace（条目存在性由 entry 判定，不以前端标记为准）
    let namespace: string | null = null;
    if (entryId) {
      try {
        namespace = (await valutService.inspectEntry(entryId)).namespace;
      } catch (err) {
        if (err instanceof Error && err.message === 'valut entry not found') {
          namespace = null; // 悬空条目：仅清理 ref
        } else {
          throw err;
        }
      }
    }

    const result = await CustomMcpServer.deleteOne({ _id: mcp._id });
    if (result.deletedCount !== 1) return false; // 并发：赢家才执行级联

    if (entryId) {
      if (namespace === MCP_BEARER_NAMESPACE) {
        await valutService.deleteEntryCascade(entryId);
      } else {
        await valutService.removeRef(MCP_BEARER_FEATURE, mcpId);
      }
    }
    return true;
  }

  private async createBearerEntry(params: {
    mcpId: string;
    name: string;
    token: string;
    workspaceId: string;
    tenantId: string;
    createdBy: string;
  }): Promise<string> {
    try {
      const created = await valutService.createManagedEntry({
        feature: MCP_BEARER_FEATURE,
        refId: params.mcpId,
        refLabel: params.name,
        key: params.name,
        value: params.token,
        editable: true,
        deletable: false,
        workspaceId: params.workspaceId,
        tenantId: params.tenantId,
        createdBy: params.createdBy,
      });
      return created.id;
    } catch (err) {
      throw mapBearerKeyError(err);
    }
  }

  /** 引用目标校验：存在 + 当前工作区可见 + namespace=manual。 */
  private async assertManualEntry(entryId: string): Promise<void> {
    const entry = await valutService.inspectEntry(entryId);
    if (entry.namespace !== MANUAL_NAMESPACE) {
      throw new Error('bearer entry must be manual namespace');
    }
  }

  /** 解绑旧关联（与删除同口径）：自建条目级联删、manual/悬空仅删 ref。 */
  private async detachBearer(mcpId: string, entryId: string): Promise<void> {
    let namespace: string | null = null;
    try {
      namespace = (await valutService.inspectEntry(entryId)).namespace;
    } catch (err) {
      if (err instanceof Error && err.message === 'valut entry not found') {
        namespace = null;
      } else {
        throw err;
      }
    }
    if (namespace === MCP_BEARER_NAMESPACE) {
      await valutService.deleteEntryCascade(entryId);
    } else {
      await valutService.removeRef(MCP_BEARER_FEATURE, mcpId);
    }
  }

  private async saveNew(doc: mongoose.Document): Promise<void> {
    try {
      await doc.save();
    } catch (err) {
      throw mapWriteError(err);
    }
  }

  private async loadView(id: string): Promise<CustomMcpServerView> {
    const doc = await this.loadMcp(id);
    const [view] = await this.mapDocs([doc]);
    return view;
  }

  /** 批量装配：一次 `loadEntryNamespaces` 派生 bearerEntryManaged（防 N+1）。 */
  private async mapDocs(docs: Doc[]): Promise<CustomMcpServerView[]> {
    const entryIds = [
      ...new Set(
        docs
          .map((doc) => doc.bearerValutEntryId)
          .filter((value) => value !== null && value !== undefined)
          .map(String),
      ),
    ];
    const namespaces = await valutService.loadEntryNamespaces(entryIds);
    return docs.map((doc) => mapServer(doc, namespaces));
  }

  /**
   * 按 id 载入（受工作区可见集约束）：
   * - 非法 id / 不存在 → `custom mcp server not found`；
   * - 存在但不在当前工作区 → `Not found`（不泄露存在性）。
   */
  private async loadMcp(id: string): Promise<Doc> {
    if (!mongoose.isValidObjectId(id)) throw new Error('custom mcp server not found');
    const doc = (await CustomMcpServer.findOne({ _id: id }).lean()) as Doc | null;
    if (doc) return doc;
    const foreign = await mongoose.connection
      .collection('custommcpservers')
      .findOne({ _id: new mongoose.Types.ObjectId(id) }, { projection: { _id: 1 } });
    if (foreign) throw new Error('Not found');
    throw new Error('custom mcp server not found');
  }
}

export const customMcpService = new CustomMcpService();
