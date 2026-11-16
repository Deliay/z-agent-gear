import mongoose from 'mongoose';
import { KnowledgeBase } from '../models/knowledge-base.js';
import type { KnowledgeBasePermissionMode } from '../models/knowledge-base.js';
import { KnowledgeBaseDocument } from '../models/knowledge-base-document.js';
import {
  KnowledgeBaseEvent,
  type KnowledgeBaseEventOp,
} from '../models/knowledge-base-event.js';
import { User } from '../models/user.js';
import {
  defaultPermissionMode,
  resolveKnowledgeBaseAccess,
  type KnowledgeBaseAccessResult,
} from './knowledge-base-access.js';
import { getWorkspaceContext, type WorkspaceContext } from './workspace-context.js';

/**
 * 知识库唯一读写口（需求 #495 / 提案 §5.2 实现点 1~2）。
 *
 * - **全部方法首参 `userId`**（GraphQL 传 `context.user.id`、MCP 传 `caller.userId`）：
 *   操作人不由 `WorkspaceContext` 承载（D6），`actorName` 在 `appendEvent` 内按 userId 快照。
 * - 入口 `requireContext()`：无 ALS 工作区上下文 → `workspace not found`（三集合不挂 scope
 *   插件，缺上下文会退化为全租户读写，必须显式拒绝）。
 * - 可见性/权限**只经** `resolveKnowledgeBaseAccess`（唯一判定源）；不可见一律「不存在」
 *   （`knowledge base not found` / 读文档返回 null），可见但越权 → `knowledge base permission denied`。
 * - 写路径不变量：「业务行变更 → 追加事件」同库顺序两步，事件写入失败**回滚业务行**并整体抛错
 *   （不留半提交）；事件集合无任何更新/删除入口。
 * - 删除文档 = 硬删除 + DELETE 快照事件（路径即刻释放）；同路径重建 = 新 CREATE 事件接续。
 */

const KB_NOT_FOUND = 'knowledge base not found';
const KB_NAME_EXISTS = 'knowledge base name already exists';
const INVALID_KB_NAME = 'invalid knowledge base name';
const NOT_TENANT_ADMIN = 'not a tenant admin';
const KB_PERMISSION_DENIED = 'knowledge base permission denied';
const DOC_NOT_FOUND = 'knowledge base document not found';
const DOC_EXISTS = 'knowledge base document already exists';
const INVALID_DOC_PATH = 'invalid document path';
const INVALID_DOC_TITLE = 'invalid document title';
const INVALID_DOC_TAGS = 'invalid document tags';
const INVALID_DOC_DESCRIPTION = 'invalid document description';
const INVALID_DOC_CONTENT = 'invalid document content';
const WORKSPACE_NOT_FOUND = 'workspace not found';

const DOC_PATH_MAX = 512;
const DOC_PATH_SEGMENT_MAX = 128;
const DOC_TITLE_MAX = 200;
const DOC_TAGS_MAX = 16;
const DOC_TAG_MAX = 32;
const DOC_DESCRIPTION_MAX = 1024;
const DOC_CONTENT_MAX = 262_144;
const EVENT_LIMIT_DEFAULT = 50;
const EVENT_LIMIT_MAX = 200;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export interface KnowledgeBaseView {
  id: string;
  name: string;
  permissionMode: KnowledgeBasePermissionMode;
  global: boolean;
  myAccess: KnowledgeBaseAccessResult;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeBaseDocumentMetaView {
  path: string;
  title: string;
  tags: string[];
  description: string;
  updatedAt: string;
}

export interface KnowledgeBaseDocumentView extends KnowledgeBaseDocumentMetaView {
  content: string;
  createdByName: string;
  updatedByName: string;
  createdAt: string;
}

export interface KnowledgeBaseTreeItemView {
  knowledgeBase: KnowledgeBaseView;
  documents: KnowledgeBaseDocumentMetaView[];
}

export interface KnowledgeBaseDocumentInput {
  title: string;
  tags: string[];
  description: string;
  content: string;
}

export interface ListEventsOptions {
  path?: string;
  limit?: number;
  before?: string;
}

export interface KnowledgeBaseEventView {
  id: string;
  path: string;
  op: KnowledgeBaseEventOp;
  title: string;
  tags: string[];
  description: string;
  content: string;
  actorName: string;
  createdAt: string;
}

interface KbRow {
  _id: unknown;
  tenantId: string;
  workspaceId: string;
  name: string;
  permissionMode: KnowledgeBasePermissionMode;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

interface DocumentRow {
  _id: unknown;
  tenantId: string;
  knowledgeBaseId: unknown;
  path: string;
  title: string;
  tags?: string[];
  description?: string;
  content?: string;
  createdBy: string;
  updatedBy: string;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

interface EventRow {
  _id: unknown;
  path: string;
  op: KnowledgeBaseEventOp;
  title: string;
  tags?: string[];
  description?: string;
  content?: string;
  actorName: string;
  createdAt?: Date | string;
}

interface DocumentSnapshot {
  title: string;
  tags: string[];
  description: string;
  content: string;
}

function toIso(value: Date | string | undefined): string {
  if (!value) return new Date(0).toISOString();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isDuplicateKey(err: unknown): boolean {
  return Boolean(
    err && typeof err === 'object' && 'code' in err && (err as { code: number }).code === 11000,
  );
}

function requireContext(): WorkspaceContext {
  const context = getWorkspaceContext();
  if (!context) throw new Error(WORKSPACE_NOT_FOUND);
  return context;
}

/** 路径归一（服务端唯一口径）：trim → 必须以 `/` 开头 → 去末尾 `/`（根除外）→ 段/全长校验。 */
export function normalizeDocumentPath(raw: string): string {
  if (typeof raw !== 'string') throw new Error(INVALID_DOC_PATH);
  let value = raw.trim();
  if (!value.startsWith('/')) throw new Error(INVALID_DOC_PATH);
  if (value.length > 1) {
    value = value.replace(/\/+$/, '');
    if (value === '') value = '/';
  }
  if (value.length > DOC_PATH_MAX) throw new Error(INVALID_DOC_PATH);
  if (CONTROL_CHARS.test(value)) throw new Error(INVALID_DOC_PATH);
  if (value === '/') return value;
  const segments = value.slice(1).split('/');
  for (const segment of segments) {
    if (segment.length === 0 || segment.length > DOC_PATH_SEGMENT_MAX) {
      throw new Error(INVALID_DOC_PATH);
    }
  }
  return `/${segments.join('/')}`;
}

function normalizeName(raw: string): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value.length === 0 || value.length > 64) throw new Error(INVALID_KB_NAME);
  return value;
}

function validatePermissionMode(raw: string): KnowledgeBasePermissionMode {
  const modes: KnowledgeBasePermissionMode[] = [
    'NONE',
    'READ_ONLY',
    'UPDATE_ONLY',
    'FULL_ACCESS',
  ];
  if (!modes.includes(raw as KnowledgeBasePermissionMode)) {
    throw new Error('invalid knowledge base permission mode');
  }
  return raw as KnowledgeBasePermissionMode;
}

function validateDocumentInput(input: KnowledgeBaseDocumentInput): DocumentSnapshot {
  const title = typeof input?.title === 'string' ? input.title.trim() : '';
  if (title.length === 0 || title.length > DOC_TITLE_MAX) {
    throw new Error(INVALID_DOC_TITLE);
  }

  if (!Array.isArray(input?.tags) || input.tags.length > DOC_TAGS_MAX) {
    throw new Error(INVALID_DOC_TAGS);
  }
  const tags: string[] = [];
  for (const raw of input.tags) {
    if (typeof raw !== 'string') throw new Error(INVALID_DOC_TAGS);
    const tag = raw.trim();
    if (tag.length === 0 || tag.length > DOC_TAG_MAX) throw new Error(INVALID_DOC_TAGS);
    if (!tags.includes(tag)) tags.push(tag);
  }

  if (typeof input?.description !== 'string' || input.description.length > DOC_DESCRIPTION_MAX) {
    throw new Error(INVALID_DOC_DESCRIPTION);
  }

  if (typeof input?.content !== 'string' || input.content.length > DOC_CONTENT_MAX) {
    throw new Error(INVALID_DOC_CONTENT);
  }

  return { title, tags, description: input.description, content: input.content };
}

function mapAccess(access: KnowledgeBaseAccessResult) {
  return {
    visible: access.visible,
    canRead: access.canRead,
    canCreate: access.canCreate,
    canUpdate: access.canUpdate,
    canDelete: access.canDelete,
    canManage: access.canManage,
  };
}

function mapKnowledgeBase(row: KbRow, context: WorkspaceContext): KnowledgeBaseView {
  const access = resolveKnowledgeBaseAccess(
    { workspaceId: String(row.workspaceId), permissionMode: row.permissionMode },
    context,
  );
  return {
    id: String(row._id),
    name: row.name,
    permissionMode: row.permissionMode,
    global: String(row.workspaceId) === context.globalWorkspaceId,
    myAccess: mapAccess(access),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

function mapDocumentMeta(row: DocumentRow): KnowledgeBaseDocumentMetaView {
  return {
    path: row.path,
    title: row.title,
    tags: row.tags ?? [],
    description: row.description ?? '',
    updatedAt: toIso(row.updatedAt),
  };
}

function snapshotOf(row: DocumentRow): DocumentSnapshot {
  return {
    title: row.title,
    tags: row.tags ?? [],
    description: row.description ?? '',
    content: row.content ?? '',
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 操作人姓名快照（账户缺失回退 userId 串）；账户改名不影响历史。 */
async function resolveActorName(userId: string): Promise<string> {
  if (!mongoose.isValidObjectId(userId)) return userId;
  const user = (await User.findById(userId).select('name').lean()) as
    | { name?: string | null }
    | null;
  return user?.name ? String(user.name) : userId;
}

/** 批量解析用户姓名（文档 createdByName/updatedByName），缺失回退 userId。 */
async function loadUserNames(userIds: string[]): Promise<Map<string, string>> {
  const valid = Array.from(new Set(userIds.filter((id) => mongoose.isValidObjectId(id))));
  const map = new Map<string, string>();
  if (valid.length === 0) return map;
  const users = (await User.find({ _id: { $in: valid } })
    .select('name')
    .lean()) as unknown as Array<{ _id: unknown; name?: string | null }>;
  for (const user of users) {
    map.set(String(user._id), user.name ? String(user.name) : String(user._id));
  }
  return map;
}

class KnowledgeBaseService {
  private async loadKnowledgeBase(
    context: WorkspaceContext,
    kbId: string,
  ): Promise<{ row: KbRow; access: KnowledgeBaseAccessResult }> {
    if (!mongoose.isValidObjectId(kbId)) throw new Error(KB_NOT_FOUND);
    const row = (await KnowledgeBase.findOne({
      _id: kbId,
      tenantId: context.tenantId,
    }).lean()) as unknown as KbRow | null;
    if (!row) throw new Error(KB_NOT_FOUND);
    const access = resolveKnowledgeBaseAccess(
      { workspaceId: String(row.workspaceId), permissionMode: row.permissionMode },
      context,
    );
    if (!access.visible) throw new Error(KB_NOT_FOUND);
    return { row, access };
  }

  /** 可见知识库列表（本工作区 ∪ 本租户全局工作区，按权限模式过滤），每条附 myAccess。 */
  async list(_userId: string): Promise<KnowledgeBaseView[]> {
    const context = requireContext();
    const rows = (await KnowledgeBase.find({
      tenantId: context.tenantId,
      workspaceId: { $in: [context.id, context.globalWorkspaceId] },
    })
      .sort({ createdAt: 1, _id: 1 })
      .lean()) as unknown as KbRow[];
    return rows
      .filter(
        (row) =>
          resolveKnowledgeBaseAccess(
            { workspaceId: String(row.workspaceId), permissionMode: row.permissionMode },
            context,
          ).visible,
      )
      .map((row) => mapKnowledgeBase(row, context));
  }

  /** 侧边栏树：可见知识库 + 各自文档元信息（不含 content）。 */
  async listTree(_userId: string): Promise<KnowledgeBaseTreeItemView[]> {
    const context = requireContext();
    const bases = await this.list(_userId);
    if (bases.length === 0) return [];
    const ids = bases.map((item) => item.id);
    const docs = (await KnowledgeBaseDocument.find({ knowledgeBaseId: { $in: ids } })
      .sort({ path: 1, _id: 1 })
      .lean()) as unknown as DocumentRow[];
    const grouped = new Map<string, KnowledgeBaseDocumentMetaView[]>();
    for (const base of bases) grouped.set(base.id, []);
    for (const doc of docs) {
      const key = String(doc.knowledgeBaseId);
      grouped.get(key)?.push(mapDocumentMeta(doc));
    }
    return bases.map((knowledgeBase) => ({
      knowledgeBase,
      documents: grouped.get(knowledgeBase.id) ?? [],
    }));
  }

  /** 创建知识库：仅租户管理员；默认模式按工作区类型（global → READ_ONLY / normal → NONE）。 */
  async create(userId: string, rawName: string): Promise<KnowledgeBaseView> {
    const context = requireContext();
    if (context.role !== 'admin') throw new Error(NOT_TENANT_ADMIN);
    const name = normalizeName(rawName);
    const duplicated = await KnowledgeBase.exists({ workspaceId: context.id, name });
    if (duplicated) throw new Error(KB_NAME_EXISTS);
    try {
      const doc = await KnowledgeBase.create({
        tenantId: context.tenantId,
        workspaceId: context.id,
        name,
        permissionMode: defaultPermissionMode(context.type),
        createdBy: userId,
      });
      return mapKnowledgeBase(doc.toObject() as unknown as KbRow, context);
    } catch (err) {
      if (isDuplicateKey(err)) throw new Error(KB_NAME_EXISTS);
      throw err;
    }
  }

  /** 改名（canManage = 租户管理员）；可见性由 access 判定。 */
  async rename(userId: string, kbId: string, rawName: string): Promise<KnowledgeBaseView> {
    void userId;
    const context = requireContext();
    const { row, access } = await this.loadKnowledgeBase(context, kbId);
    if (!access.canManage) throw new Error(KB_PERMISSION_DENIED);
    const name = normalizeName(rawName);
    if (name !== row.name) {
      const duplicated = await KnowledgeBase.exists({
        _id: { $ne: kbId },
        workspaceId: row.workspaceId,
        name,
      });
      if (duplicated) throw new Error(KB_NAME_EXISTS);
    }
    try {
      const updated = (await KnowledgeBase.findOneAndUpdate(
        { _id: kbId, tenantId: context.tenantId },
        { $set: { name } },
        { returnDocument: 'after' },
      ).lean()) as unknown as KbRow | null;
      if (!updated) throw new Error(KB_NOT_FOUND);
      return mapKnowledgeBase(updated, context);
    } catch (err) {
      if (isDuplicateKey(err)) throw new Error(KB_NAME_EXISTS);
      throw err;
    }
  }

  /** 更新权限模式（canManage）；四档枚举校验。 */
  async updatePermission(
    userId: string,
    kbId: string,
    permissionMode: KnowledgeBasePermissionMode,
  ): Promise<KnowledgeBaseView> {
    void userId;
    const context = requireContext();
    const { access } = await this.loadKnowledgeBase(context, kbId);
    if (!access.canManage) throw new Error(KB_PERMISSION_DENIED);
    const mode = validatePermissionMode(String(permissionMode));
    const updated = (await KnowledgeBase.findOneAndUpdate(
      { _id: kbId, tenantId: context.tenantId },
      { $set: { permissionMode: mode } },
      { returnDocument: 'after' },
    ).lean()) as unknown as KbRow | null;
    if (!updated) throw new Error(KB_NOT_FOUND);
    return mapKnowledgeBase(updated, context);
  }

  /** 删除知识库：canManage；级联删除文档与事件（事件集合无其他删除入口）。 */
  async remove(userId: string, kbId: string): Promise<boolean> {
    void userId;
    const context = requireContext();
    const { access } = await this.loadKnowledgeBase(context, kbId);
    if (!access.canManage) throw new Error(KB_PERMISSION_DENIED);
    const deleted = await KnowledgeBase.deleteOne({ _id: kbId, tenantId: context.tenantId });
    if (deleted.deletedCount !== 1) throw new Error(KB_NOT_FOUND);
    await KnowledgeBaseDocument.deleteMany({ knowledgeBaseId: kbId });
    await KnowledgeBaseEvent.deleteMany({ knowledgeBaseId: kbId });
    return true;
  }

  /** 文档元信息列表（可按路径前缀过滤；不含 content）。 */
  async listDocuments(
    userId: string,
    kbId: string,
    prefix?: string,
  ): Promise<KnowledgeBaseDocumentMetaView[]> {
    void userId;
    const context = requireContext();
    const { access } = await this.loadKnowledgeBase(context, kbId);
    if (!access.canRead) throw new Error(KB_PERMISSION_DENIED);
    const filter: Record<string, unknown> = { knowledgeBaseId: kbId };
    const trimmed = typeof prefix === 'string' ? prefix.trim() : '';
    if (trimmed.length > 0) {
      filter.path = { $regex: `^${escapeRegExp(trimmed)}` };
    }
    const rows = (await KnowledgeBaseDocument.find(filter)
      .sort({ path: 1, _id: 1 })
      .lean()) as unknown as DocumentRow[];
    return rows.map(mapDocumentMeta);
  }

  /** 单文档完整内容；不可见/无读权限/不存在统一 null（不泄露存在性）。 */
  async getDocument(
    userId: string,
    kbId: string,
    rawPath: string,
  ): Promise<KnowledgeBaseDocumentView | null> {
    void userId;
    const context = requireContext();
    let row: DocumentRow | null;
    try {
      const { access } = await this.loadKnowledgeBase(context, kbId);
      if (!access.canRead) return null;
      const path = normalizeDocumentPath(rawPath);
      row = (await KnowledgeBaseDocument.findOne({
        knowledgeBaseId: kbId,
        path,
      }).lean()) as unknown as DocumentRow | null;
    } catch (err) {
      if (err instanceof Error && err.message === KB_NOT_FOUND) return null;
      throw err;
    }
    if (!row) return null;
    return this.mapDocumentWithNames(row);
  }

  /** 创建文档：canCreate；路径归一 + 输入校验；同路径预检与 E11000 收敛。 */
  async createDocument(
    userId: string,
    kbId: string,
    rawPath: string,
    input: KnowledgeBaseDocumentInput,
  ): Promise<KnowledgeBaseDocumentView> {
    const context = requireContext();
    const { access } = await this.loadKnowledgeBase(context, kbId);
    if (!access.canCreate) throw new Error(KB_PERMISSION_DENIED);
    const path = normalizeDocumentPath(rawPath);
    const snapshot = validateDocumentInput(input);
    const exists = await KnowledgeBaseDocument.exists({ knowledgeBaseId: kbId, path });
    if (exists) throw new Error(DOC_EXISTS);

    let created: DocumentRow;
    try {
      const doc = await KnowledgeBaseDocument.create({
        tenantId: context.tenantId,
        knowledgeBaseId: kbId,
        path,
        ...snapshot,
        createdBy: userId,
        updatedBy: userId,
      });
      created = doc.toObject() as unknown as DocumentRow;
    } catch (err) {
      if (isDuplicateKey(err)) throw new Error(DOC_EXISTS);
      throw err;
    }

    try {
      await this.appendEvent(context, kbId, path, 'CREATE', snapshot, userId);
    } catch (err) {
      // 事件失败整体抛错且不留半提交：回滚刚创建的业务行
      await KnowledgeBaseDocument.deleteOne({ _id: created._id }).catch(() => undefined);
      throw err;
    }
    return this.mapDocumentWithNames(created);
  }

  /** 更新文档：canUpdate；matchedCount=0 → 不存在；更新后追加 UPDATE 事件。 */
  async updateDocument(
    userId: string,
    kbId: string,
    rawPath: string,
    input: KnowledgeBaseDocumentInput,
  ): Promise<KnowledgeBaseDocumentView> {
    const context = requireContext();
    const { access } = await this.loadKnowledgeBase(context, kbId);
    if (!access.canUpdate) throw new Error(KB_PERMISSION_DENIED);
    const path = normalizeDocumentPath(rawPath);
    const snapshot = validateDocumentInput(input);
    const existing = (await KnowledgeBaseDocument.findOne({
      knowledgeBaseId: kbId,
      path,
    }).lean()) as unknown as DocumentRow | null;
    if (!existing) throw new Error(DOC_NOT_FOUND);
    const before = snapshotOf(existing);

    const result = await KnowledgeBaseDocument.updateOne(
      { _id: existing._id },
      { $set: { ...snapshot, updatedBy: userId } },
    );
    if (result.matchedCount === 0) throw new Error(DOC_NOT_FOUND);

    try {
      await this.appendEvent(context, kbId, path, 'UPDATE', snapshot, userId);
    } catch (err) {
      await KnowledgeBaseDocument.updateOne(
        { _id: existing._id },
        { $set: { ...before, updatedBy: existing.updatedBy } },
      ).catch(() => undefined);
      throw err;
    }

    const updated = (await KnowledgeBaseDocument.findById(existing._id).lean()) as unknown as
      | DocumentRow
      | null;
    if (!updated) throw new Error(DOC_NOT_FOUND);
    return this.mapDocumentWithNames(updated);
  }

  /**
   * MCP 专用 upsert：存在走更新（canUpdate）、不存在走创建（canCreate），权限分支各自判定。
   */
  async upsertDocument(
    userId: string,
    kbId: string,
    rawPath: string,
    input: KnowledgeBaseDocumentInput,
  ): Promise<KnowledgeBaseDocumentView> {
    const context = requireContext();
    const { access } = await this.loadKnowledgeBase(context, kbId);
    const path = normalizeDocumentPath(rawPath);
    const existing = await KnowledgeBaseDocument.exists({ knowledgeBaseId: kbId, path });
    if (existing) {
      if (!access.canUpdate) throw new Error(KB_PERMISSION_DENIED);
      return this.updateDocument(userId, kbId, path, input);
    }
    if (!access.canCreate) throw new Error(KB_PERMISSION_DENIED);
    return this.createDocument(userId, kbId, path, input);
  }

  /** 删除文档：canDelete；DELETE 快照 = 删除前最后内容；路径即刻释放。 */
  async deleteDocument(userId: string, kbId: string, rawPath: string): Promise<boolean> {
    const context = requireContext();
    const { access } = await this.loadKnowledgeBase(context, kbId);
    if (!access.canDelete) throw new Error(KB_PERMISSION_DENIED);
    const path = normalizeDocumentPath(rawPath);
    const existing = (await KnowledgeBaseDocument.findOne({
      knowledgeBaseId: kbId,
      path,
    }).lean()) as unknown as DocumentRow | null;
    if (!existing) throw new Error(DOC_NOT_FOUND);
    const snapshot = snapshotOf(existing);

    const result = await KnowledgeBaseDocument.deleteOne({ _id: existing._id });
    if (result.deletedCount !== 1) throw new Error(DOC_NOT_FOUND);

    try {
      await this.appendEvent(context, kbId, path, 'DELETE', snapshot, userId);
    } catch (err) {
      await KnowledgeBaseDocument.create({
        tenantId: existing.tenantId,
        knowledgeBaseId: existing.knowledgeBaseId as mongoose.Types.ObjectId,
        path: existing.path,
        ...snapshot,
        createdBy: existing.createdBy,
        updatedBy: existing.updatedBy,
      }).catch(() => undefined);
      throw err;
    }
    return true;
  }

  /** 历史事件：canRead；恒 createdAt 倒序；limit 缺省 50 / 上限 200；before 为 ISO 游标。 */
  async listEvents(
    userId: string,
    kbId: string,
    options: ListEventsOptions = {},
  ): Promise<KnowledgeBaseEventView[]> {
    void userId;
    const context = requireContext();
    const { access } = await this.loadKnowledgeBase(context, kbId);
    if (!access.canRead) throw new Error(KB_PERMISSION_DENIED);

    const filter: Record<string, unknown> = { knowledgeBaseId: kbId };
    if (options.path !== undefined && options.path !== null) {
      filter.path = normalizeDocumentPath(options.path);
    }
    if (options.before) {
      const before = new Date(options.before);
      if (!Number.isNaN(before.getTime())) {
        filter.createdAt = { $lt: before };
      }
    }
    let limit = EVENT_LIMIT_DEFAULT;
    if (typeof options.limit === 'number' && Number.isFinite(options.limit)) {
      limit = Math.min(Math.max(Math.trunc(options.limit), 1), EVENT_LIMIT_MAX);
    }
    const rows = (await KnowledgeBaseEvent.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit)
      .lean()) as unknown as EventRow[];
    return rows.map((row) => ({
      id: String(row._id),
      path: row.path,
      op: row.op,
      title: row.title,
      tags: row.tags ?? [],
      description: row.description ?? '',
      content: row.content ?? '',
      actorName: row.actorName,
      createdAt: toIso(row.createdAt),
    }));
  }

  private async mapDocumentWithNames(row: DocumentRow): Promise<KnowledgeBaseDocumentView> {
    const names = await loadUserNames([row.createdBy, row.updatedBy]);
    return {
      ...mapDocumentMeta(row),
      content: row.content ?? '',
      createdByName: names.get(row.createdBy) ?? row.createdBy,
      updatedByName: names.get(row.updatedBy) ?? row.updatedBy,
      createdAt: toIso(row.createdAt),
    };
  }

  private async appendEvent(
    context: WorkspaceContext,
    kbId: string,
    path: string,
    op: KnowledgeBaseEventOp,
    snapshot: DocumentSnapshot,
    actorId: string,
  ): Promise<void> {
    const actorName = await resolveActorName(actorId);
    await KnowledgeBaseEvent.create({
      tenantId: context.tenantId,
      knowledgeBaseId: kbId,
      path,
      op,
      title: snapshot.title,
      tags: snapshot.tags,
      description: snapshot.description,
      content: snapshot.content,
      actorId,
      actorName,
    });
  }
}

export const knowledgeBaseService = new KnowledgeBaseService();
