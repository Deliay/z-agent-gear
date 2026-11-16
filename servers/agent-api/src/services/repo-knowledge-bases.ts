import { CloudHost } from '../models/cloud-host.js';
import { Controller } from '../models/controller.js';
import { controllerWorkspaceService } from './controller-workspace.js';
import { actorFilter } from './workspace-context.js';
import { publish } from '../middleware/publish.js';
import { getRedisClient } from '../middleware/redis.js';
import { compareVersions } from './version.js';
import { normalizeDocumentPath } from './knowledge-base-service.js';

/**
 * 仓库内建知识库分层只读服务（需求 #545 / 技术提案 v1.1）。
 *
 * 契约：
 * - `packages/agent-controller/src/knowledge-bases.ts` 扫描两个约定目录（跨包同源常量见注释）；
 * - Redis `knowledge-bases:scan:{requestId}`（中继写，EX 60，读后即删）；
 * - 工作区级缓存 `repo-knowledge-bases:ws:{workspaceId}`（EX 300，解析后的知识库全集）；
 * - 仓库为唯一事实源：不落 MongoDB、不进知识库 MCP 工具、无任何写入口。
 *
 * 错误口径（D4/D5）：
 * - `listKnowledgeBases` 归属校验失败 → `Workspace not found`；
 * - 扫描链路任何失败（离线/版本不足/超时/success:false/非法 JSON/中继异常）→
 *   `repo knowledge base scan failed`；
 * - `listChildren` / `getDocument` 对任何不可达统一 `[]` / `null`（不泄露存在性）。
 */

/** agent-gear 2.19.0 起支持 knowledge-bases:scan */
export const REPO_KNOWLEDGE_BASE_MIN_AGENT_GEAR_VERSION = '2.19.0';
/** 扫描结果轮询口径（与 workflow-templates:scan 同参数：500ms × 30 ≈ 15s） */
export const REPO_KB_POLL_INTERVAL_MS = 500;
export const REPO_KB_POLL_ATTEMPTS = 30;
/** 工作区级解析结果缓存 TTL */
export const REPO_KB_CACHE_TTL_SECONDS = 300;
/** 工作区级缓存键前缀 */
export const REPO_KB_CACHE_KEY_PREFIX = 'repo-knowledge-bases:ws:';

export type RepoKnowledgeBaseSource = 'ZAG' | 'DOCS';
export type RepoKnowledgeBaseNodeKind = 'FOLDER' | 'DOCUMENT';

export interface RepoKnowledgeBaseHost {
  cloudHostId: string;
  cloudHostName: string;
  workspaceId: string;
  scanSupported: boolean;
}

export interface RepoKnowledgeBaseView {
  id: string;
  name: string;
  description: string;
  source: RepoKnowledgeBaseSource;
  folder: string;
  workspaceId: string;
  cloudHostId: string;
  cloudHostName: string;
  valid: boolean;
  errors: string[];
  documentCount: number;
  truncated: boolean;
}

export interface RepoKnowledgeBaseNode {
  kind: RepoKnowledgeBaseNodeKind;
  name: string;
  path: string;
}

export interface RepoKnowledgeBaseDocumentView {
  path: string;
  title: string;
  content: string;
}

export interface ParsedRepoKbSchema {
  name: string;
  description: string;
  errors: string[];
}

export interface RepoFrontMatterEntry {
  key: string;
  value: string;
}

export interface RepoFrontMatterSplit {
  entries: RepoFrontMatterEntry[];
  body: string;
  present: boolean;
}

export interface ParsedRepoDocument {
  /** 扫描器返回的库内相对路径 */
  rawPath: string;
  /** 归一后的库内路径（`/` 开头）；非法时为 null */
  path: string | null;
  title: string;
  tags: string[];
  description: string;
  content: string;
  errors: string[];
}

interface CachedRepoDocument {
  path: string;
  title: string;
  tags: string[];
  description: string;
  content: string;
}

interface CachedRepoKnowledgeBase {
  id: string;
  name: string;
  description: string;
  source: RepoKnowledgeBaseSource;
  folder: string;
  workspaceId: string;
  cloudHostId: string;
  cloudHostName: string;
  valid: boolean;
  errors: string[];
  documentCount: number;
  truncated: boolean;
  documents: CachedRepoDocument[];
}

interface RepoKnowledgeBaseCache {
  workspaceId: string;
  cloudHostId: string;
  cloudHostName: string;
  knowledgeBases: CachedRepoKnowledgeBase[];
}

interface DecodedRepoKnowledgeBaseId {
  workspaceId: string;
  source: RepoKnowledgeBaseSource;
  folder: string;
}

interface RawDocument {
  path?: unknown;
  content?: unknown;
  error?: unknown;
}

interface RawKnowledgeBase {
  folder?: unknown;
  schema?: unknown;
  documents?: unknown;
  truncated?: unknown;
  error?: unknown;
}

interface RawSource {
  source?: unknown;
  knowledgeBases?: unknown;
  truncated?: unknown;
}

const SOURCE_BY_RAW: Record<string, RepoKnowledgeBaseSource> = {
  zag: 'ZAG',
  docs: 'DOCS',
};
const RAW_BY_SOURCE: Record<RepoKnowledgeBaseSource, 'zag' | 'docs'> = {
  ZAG: 'zag',
  DOCS: 'docs',
};
/** 来源声明序（zag 先于 docs，D7） */
const SOURCE_ORDER: RepoKnowledgeBaseSource[] = ['ZAG', 'DOCS'];

const DOC_TITLE_MAX = 200;
const DOC_TAGS_MAX = 16;
const DOC_TAG_MAX = 32;
const DOC_DESCRIPTION_MAX = 1024;
const FRONT_MATTER_SCAN_BYTES = 4096;

const SCHEMA_INVALID_JSON = 'knowledge-base.json 不是合法的 JSON 文件';
const SCHEMA_INVALID_NAME = '知识库名称不合法（name 必填，trim 后 1~64 字符）';
const SCHEMA_INVALID_DESCRIPTION = '知识库描述不合法（description 可选，≤1024 字符）';
const SCAN_FAILED = 'repo knowledge base scan failed';
const WORKSPACE_NOT_FOUND = 'Workspace not found';

export function isRepoKnowledgeBaseScanSupported(version: unknown): boolean {
  if (typeof version !== 'string' || version.trim() === '') return false;
  try {
    return compareVersions(version, REPO_KNOWLEDGE_BASE_MIN_AGENT_GEAR_VERSION) >= 0;
  } catch {
    return false;
  }
}

export function encodeRepoKnowledgeBaseId(
  workspaceId: string,
  source: RepoKnowledgeBaseSource,
  folder: string,
): string {
  return `repo:${workspaceId}:${RAW_BY_SOURCE[source]}:${encodeURIComponent(folder)}`;
}

export function decodeRepoKnowledgeBaseId(id: string): DecodedRepoKnowledgeBaseId | null {
  if (typeof id !== 'string' || !id.startsWith('repo:')) return null;
  const rest = id.slice('repo:'.length);
  const first = rest.indexOf(':');
  if (first <= 0) return null;
  const workspaceId = rest.slice(0, first);
  const rest2 = rest.slice(first + 1);
  const second = rest2.indexOf(':');
  if (second <= 0) return null;
  const rawSource = rest2.slice(0, second);
  const source = SOURCE_BY_RAW[rawSource];
  if (!source) return null;
  let folder: string;
  try {
    folder = decodeURIComponent(rest2.slice(second + 1));
  } catch {
    return null;
  }
  if (folder.trim() === '') return null;
  return { workspaceId, source, folder };
}

/** 解析 knowledge-base.json（纯函数）；错误文案逐字见计划 D8。 */
export function parseRepoKnowledgeBaseSchema(raw: string): ParsedRepoKbSchema {
  const errors: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { name: '', description: '', errors: [SCHEMA_INVALID_JSON] };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { name: '', description: '', errors: [SCHEMA_INVALID_JSON] };
  }
  const record = parsed as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  if (name.length === 0 || name.length > 64) errors.push(SCHEMA_INVALID_NAME);

  let description = '';
  if (record.description !== undefined && record.description !== null) {
    if (typeof record.description !== 'string' || record.description.length > 1024) {
      errors.push(SCHEMA_INVALID_DESCRIPTION);
    } else {
      description = record.description;
    }
  }
  return { name, description, errors };
}

/**
 * 极简 front matter 拆分（纯函数，与服务端元信息解析同口径）。
 *
 * 仅当内容以 `---\n` 开头且前 4KiB 内存在闭合 `\n---` 时解析；逐行 `key: value`
 * （键/值 trim，值不含换行）。块非法按「无 front matter」处理。
 */
export function splitRepoFrontMatter(content: string): RepoFrontMatterSplit {
  const fallback: RepoFrontMatterSplit = { entries: [], body: content, present: false };
  if (!content.startsWith('---\n')) return fallback;
  const head = content.slice(0, FRONT_MATTER_SCAN_BYTES);
  const close = head.indexOf('\n---', 3);
  if (close < 0) return fallback;

  const block = head.slice(4, close);
  const entries: RepoFrontMatterEntry[] = [];
  for (const rawLine of block.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const colon = trimmed.indexOf(':');
    if (colon <= 0) {
      // 块非法：整体按无 front matter
      return fallback;
    }
    const key = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    if (key === '') return fallback;
    entries.push({ key, value });
  }

  let bodyStart = close + 4; // '\n---'
  if (content.startsWith('\r\n', bodyStart)) bodyStart += 2;
  else if (content[bodyStart] === '\n') bodyStart += 1;
  return { entries, body: content.slice(bodyStart), present: true };
}

function parseTagsValue(raw: string): string[] | null {
  const trimmed = raw.trim();
  if (trimmed === '') return [];
  let items: string[];
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    items = trimmed.slice(1, -1).split(',');
  } else {
    items = trimmed.split(',');
  }
  const tags: string[] = [];
  for (const item of items) {
    const tag = item.trim();
    if (tag.length === 0 || tag.length > DOC_TAG_MAX) return null;
    if (!tags.includes(tag)) tags.push(tag);
  }
  if (tags.length > DOC_TAGS_MAX) return null;
  return tags;
}

function fallbackTitle(rawPath: string): string {
  const normalized = rawPath.replace(/\\/g, '/');
  const segment = normalized.slice(normalized.lastIndexOf('/') + 1);
  return segment.replace(/\.md$/i, '') || segment;
}

function firstHeading(body: string): string {
  const match = body.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : '';
}

/**
 * 解析单文档（纯函数）：front matter 三键元信息 + 标题回退链 +
 * 路径归一（复用平台 `normalizeDocumentPath`）。`content` 恒为原文全文（含 front matter）。
 */
export function parseRepoDocument(rawPath: string, content: string): ParsedRepoDocument {
  const errors: string[] = [];
  const split = splitRepoFrontMatter(content);

  let title = '';
  let tags: string[] = [];
  let description = '';

  for (const entry of split.entries) {
    if (entry.key === 'title') {
      const value = entry.value.trim();
      if (value.length >= 1 && value.length <= DOC_TITLE_MAX) title = value;
    } else if (entry.key === 'tags') {
      const parsed = parseTagsValue(entry.value);
      if (parsed) tags = parsed;
    } else if (entry.key === 'description') {
      if (entry.value.length <= DOC_DESCRIPTION_MAX) description = entry.value;
    }
  }

  if (!title) title = firstHeading(split.body);
  if (!title) title = fallbackTitle(rawPath);

  const withoutExt = rawPath.replace(/\\/g, '/').replace(/\.md$/i, '');
  let path: string | null = null;
  try {
    path = normalizeDocumentPath(`/${withoutExt}`);
  } catch {
    errors.push(`文档路径不合法：${rawPath}`);
  }

  return { rawPath, path, title, tags, description, content, errors };
}

/** 逐级派生子条目（纯函数）：文件夹在前、同组按名 localeCompare。 */
export function buildKnowledgeBaseChildren(
  docs: Array<{ path: string; title: string }>,
  prefix: string,
): RepoKnowledgeBaseNode[] {
  let base = typeof prefix === 'string' ? prefix.trim() : '';
  if (base === '' || base === '/') base = '';
  else base = normalizeDocumentPath(base);

  const folders = new Map<string, string>();
  const documents: RepoKnowledgeBaseNode[] = [];

  for (const doc of docs) {
    if (!doc.path.startsWith('/')) continue;
    if (base) {
      if (!doc.path.startsWith(`${base}/`)) continue;
    }
    const rest = base ? doc.path.slice(base.length + 1) : doc.path.slice(1);
    if (rest === '') continue;
    const parts = rest.split('/');
    if (parts.length === 1) {
      documents.push({ kind: 'DOCUMENT', name: doc.title, path: doc.path });
    } else {
      const folderPath = `${base}/${parts[0]}`;
      folders.set(parts[0], folderPath);
    }
  }

  const folderNodes: RepoKnowledgeBaseNode[] = [...folders.entries()]
    .map(([name, path]) => ({ kind: 'FOLDER' as const, name, path }))
    .sort((a, b) => a.name.localeCompare(b.name));
  documents.sort((a, b) => {
    const diff = a.name.localeCompare(b.name);
    return diff !== 0 ? diff : a.path.localeCompare(b.path);
  });
  return [...folderNodes, ...documents];
}

function scanFailed(): Error {
  return new Error(SCAN_FAILED);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class RepoKnowledgeBaseService {
  /** 候选云电脑骨架：纯 DB 读，不触发任何仓库扫描（D14）。 */
  async listHosts(userId: string): Promise<RepoKnowledgeBaseHost[]> {
    const hosts = (await CloudHost.find({
      ...actorFilter(userId),
      status: 'RUNNING',
      workspaceId: { $ne: null },
      deletedAt: null,
    }).lean()) as unknown as Array<{
      _id: unknown;
      name?: unknown;
      workspaceId?: unknown;
      controllerId?: unknown;
    }>;

    const controllerIds = Array.from(
      new Set(hosts.map((host) => String(host.controllerId)).filter((id) => id !== '')),
    );
    const controllers =
      controllerIds.length === 0
        ? []
        : ((await Controller.find({ _id: { $in: controllerIds } }).lean()) as unknown as Array<{
            _id: unknown;
            status?: unknown;
            version?: unknown;
          }>);
    const controllerById = new Map(controllers.map((row) => [String(row._id), row]));

    return hosts
      .map((host) => {
        const controller = controllerById.get(String(host.controllerId));
        return {
          cloudHostId: String(host._id),
          cloudHostName: typeof host.name === 'string' ? host.name : String(host._id),
          workspaceId: String(host.workspaceId ?? ''),
          scanSupported:
            controller?.status === 'online' &&
            isRepoKnowledgeBaseScanSupported(controller.version),
        };
      })
      .filter((host) => host.workspaceId !== '')
      .sort((a, b) => {
        const diff = a.cloudHostName.localeCompare(b.cloudHostName);
        return diff !== 0 ? diff : a.cloudHostId.localeCompare(b.cloudHostId);
      });
  }

  /** 单云电脑默认工作区的知识库列表；缓存优先，miss/refresh 触发扫描。 */
  async listKnowledgeBases(
    userId: string,
    workspaceId: string,
    refresh?: boolean,
  ): Promise<RepoKnowledgeBaseView[]> {
    const workspace = await controllerWorkspaceService.findById(workspaceId, userId);
    if (!workspace) throw new Error(WORKSPACE_NOT_FOUND);

    const host = (await CloudHost.findOne({
      workspaceId,
      status: 'RUNNING',
      deletedAt: null,
      ...actorFilter(userId),
    }).lean()) as unknown as {
      _id: unknown;
      name?: unknown;
    } | null;
    if (!host) throw new Error(WORKSPACE_NOT_FOUND);

    const cacheKey = `${REPO_KB_CACHE_KEY_PREFIX}${workspaceId}`;
    const redis = getRedisClient();
    if (refresh) {
      await redis.del(cacheKey).catch(() => undefined);
    } else {
      const cached = await redis.get(cacheKey).catch(() => null);
      if (cached) {
        try {
          const parsedCache = JSON.parse(cached) as RepoKnowledgeBaseCache;
          if (Array.isArray(parsedCache.knowledgeBases)) {
            return this.mapCacheToViews(parsedCache);
          }
        } catch {
          // 缓存损坏：忽略并按 miss 重扫
        }
      }
    }

    const cache = await this.scanWorkspace(userId, workspace, host);
    await redis
      .set(cacheKey, JSON.stringify(cache), 'EX', REPO_KB_CACHE_TTL_SECONDS)
      .catch(() => undefined);
    return this.mapCacheToViews(cache);
  }

  /** 知识库内某目录的直接子条目；任何不可达统一 `[]`。 */
  async listChildren(
    userId: string,
    id: string,
    path?: string,
  ): Promise<RepoKnowledgeBaseNode[]> {
    try {
      const decoded = decodeRepoKnowledgeBaseId(id);
      if (!decoded) return [];
      const loaded = await this.loadCachedKnowledgeBase(userId, decoded);
      if (!loaded) return [];
      const docs = loaded.documents.map((doc) => ({ path: doc.path, title: doc.title }));
      return buildKnowledgeBaseChildren(docs, path ?? '/');
    } catch {
      return [];
    }
  }

  /** 单文档完整内容；任何不可达统一 `null`。content 为原文全文（含 front matter）。 */
  async getDocument(
    userId: string,
    id: string,
    rawPath: string,
  ): Promise<RepoKnowledgeBaseDocumentView | null> {
    try {
      const decoded = decodeRepoKnowledgeBaseId(id);
      if (!decoded) return null;
      const loaded = await this.loadCachedKnowledgeBase(userId, decoded);
      if (!loaded) return null;
      const path = normalizeDocumentPath(rawPath);
      const doc = loaded.documents.find((item) => item.path === path);
      if (!doc) return null;
      return { path: doc.path, title: doc.title, content: doc.content };
    } catch {
      return null;
    }
  }

  private async loadCachedKnowledgeBase(
    userId: string,
    decoded: DecodedRepoKnowledgeBaseId,
  ): Promise<CachedRepoKnowledgeBase | null> {
    const workspace = await controllerWorkspaceService.findById(decoded.workspaceId, userId);
    if (!workspace) return null;
    const host = (await CloudHost.findOne({
      workspaceId: decoded.workspaceId,
      status: 'RUNNING',
      deletedAt: null,
      ...actorFilter(userId),
    }).lean()) as unknown as { _id: unknown; name?: unknown } | null;
    if (!host) return null;

    const cacheKey = `${REPO_KB_CACHE_KEY_PREFIX}${decoded.workspaceId}`;
    const redis = getRedisClient();
    const cached = await redis.get(cacheKey).catch(() => null);
    let cache: RepoKnowledgeBaseCache | null = null;
    if (cached) {
      try {
        const parsedCache = JSON.parse(cached) as RepoKnowledgeBaseCache;
        if (Array.isArray(parsedCache.knowledgeBases)) cache = parsedCache;
      } catch {
        cache = null;
      }
    }
    if (!cache) {
      // 缓存 miss：触发一次重扫（等价一次列表加载）；失败按不可达收敛
      try {
        cache = await this.scanWorkspace(userId, workspace, host);
        await redis
          .set(cacheKey, JSON.stringify(cache), 'EX', REPO_KB_CACHE_TTL_SECONDS)
          .catch(() => undefined);
      } catch {
        return null;
      }
    }
    return (
      cache.knowledgeBases.find(
        (item) => item.source === decoded.source && item.folder === decoded.folder,
      ) ?? null
    );
  }

  private async scanWorkspace(
    userId: string,
    workspace: Record<string, unknown>,
    host: { _id: unknown; name?: unknown },
  ): Promise<RepoKnowledgeBaseCache> {
    const workspaceId = String(workspace.id ?? workspace._id ?? '');
    const controllerId = String(workspace.controllerId ?? '');
    const path = typeof workspace.path === 'string' ? workspace.path : '';

    const controller = (await Controller.findOne({
      _id: controllerId,
      ...actorFilter(userId),
    }).lean()) as unknown as { status?: unknown; version?: unknown } | null;
    if (
      !controller ||
      controller.status !== 'online' ||
      !isRepoKnowledgeBaseScanSupported(controller.version)
    ) {
      throw scanFailed();
    }

    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const redis = getRedisClient();
    await publish('session:command', {
      type: 'knowledge-bases:scan',
      requestId,
      controllerId,
      path,
    });

    for (let attempt = 0; attempt < REPO_KB_POLL_ATTEMPTS; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, REPO_KB_POLL_INTERVAL_MS));
      const raw = await redis.get(`knowledge-bases:scan:${requestId}`);
      if (!raw) continue;
      await redis.del(`knowledge-bases:scan:${requestId}`).catch(() => undefined);
      let parsed: { success?: boolean; sources?: unknown };
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw scanFailed();
      }
      if (!parsed.success || !Array.isArray(parsed.sources)) throw scanFailed();
      return this.buildCache(
        parsed.sources as RawSource[],
        workspaceId,
        String(host._id),
        typeof host.name === 'string' ? host.name : String(host._id),
      );
    }

    throw scanFailed();
  }

  private buildCache(
    rawSources: RawSource[],
    workspaceId: string,
    cloudHostId: string,
    cloudHostName: string,
  ): RepoKnowledgeBaseCache {
    const bySource = new Map<string, RawSource>();
    for (const source of rawSources) {
      if (!isRecord(source)) continue;
      if (typeof source.source !== 'string') continue;
      bySource.set(source.source, source);
    }

    const knowledgeBases: CachedRepoKnowledgeBase[] = [];
    for (const source of SOURCE_ORDER) {
      const rawSource = bySource.get(RAW_BY_SOURCE[source]);
      const entries = Array.isArray(rawSource?.knowledgeBases)
        ? (rawSource.knowledgeBases as RawKnowledgeBase[])
        : [];
      const mapped: CachedRepoKnowledgeBase[] = [];
      for (const rawEntry of entries) {
        if (!isRecord(rawEntry)) continue;
        if (typeof rawEntry.folder !== 'string' || rawEntry.folder.trim() === '') continue;
        mapped.push(
          this.buildKnowledgeBase(source, rawEntry, workspaceId, cloudHostId, cloudHostName),
        );
      }
      mapped.sort((a, b) => a.folder.localeCompare(b.folder));
      knowledgeBases.push(...mapped);
    }

    return { workspaceId, cloudHostId, cloudHostName, knowledgeBases };
  }

  private buildKnowledgeBase(
    source: RepoKnowledgeBaseSource,
    raw: RawKnowledgeBase,
    workspaceId: string,
    cloudHostId: string,
    cloudHostName: string,
  ): CachedRepoKnowledgeBase {
    const folder = String(raw.folder);
    const base: CachedRepoKnowledgeBase = {
      id: encodeRepoKnowledgeBaseId(workspaceId, source, folder),
      name: '',
      description: '',
      source,
      folder,
      workspaceId,
      cloudHostId,
      cloudHostName,
      valid: false,
      errors: [],
      documentCount: 0,
      truncated: raw.truncated === true,
      documents: [],
    };

    if (typeof raw.error === 'string' && raw.error.trim() !== '') {
      return { ...base, errors: [raw.error] };
    }

    const schema = parseRepoKnowledgeBaseSchema(
      typeof raw.schema === 'string' ? raw.schema : '',
    );
    base.name = schema.name;
    base.description = schema.description;
    if (schema.errors.length > 0) {
      return { ...base, errors: schema.errors };
    }

    const errors: string[] = [];
    const accepted = new Map<string, CachedRepoDocument>();
    const conflicted = new Set<string>();
    const rawDocuments = Array.isArray(raw.documents) ? (raw.documents as RawDocument[]) : [];
    for (const rawDoc of rawDocuments) {
      if (!isRecord(rawDoc) || typeof rawDoc.path !== 'string') continue;
      if (typeof rawDoc.error === 'string' && rawDoc.error.trim() !== '') {
        errors.push(`文档读取失败：${rawDoc.path}（${rawDoc.error}）`);
        continue;
      }
      const content = typeof rawDoc.content === 'string' ? rawDoc.content : '';
      const parsedDoc = parseRepoDocument(rawDoc.path, content);
      if (!parsedDoc.path || parsedDoc.errors.length > 0) {
        errors.push(...(parsedDoc.errors.length > 0 ? parsedDoc.errors : [`文档路径不合法：${rawDoc.path}`]));
        continue;
      }
      if (conflicted.has(parsedDoc.path)) continue;
      if (accepted.has(parsedDoc.path)) {
        errors.push(`文档路径冲突：${parsedDoc.path}`);
        accepted.delete(parsedDoc.path);
        conflicted.add(parsedDoc.path);
        continue;
      }
      accepted.set(parsedDoc.path, {
        path: parsedDoc.path,
        title: parsedDoc.title,
        tags: parsedDoc.tags,
        description: parsedDoc.description,
        content: parsedDoc.content,
      });
    }

    const documents = [...accepted.values()].sort((a, b) => a.path.localeCompare(b.path));
    return {
      ...base,
      valid: errors.length === 0,
      errors,
      documentCount: errors.length === 0 ? documents.length : 0,
      documents,
    };
  }

  private mapCacheToViews(cache: RepoKnowledgeBaseCache): RepoKnowledgeBaseView[] {
    const result: RepoKnowledgeBaseView[] = [];
    for (const source of SOURCE_ORDER) {
      const subset = cache.knowledgeBases.filter((item) => item.source === source);
      for (const item of subset) {
        result.push({
          id: item.id,
          name: item.name,
          description: item.description,
          source: item.source,
          folder: item.folder,
          workspaceId: item.workspaceId,
          cloudHostId: item.cloudHostId,
          cloudHostName: item.cloudHostName,
          valid: item.valid,
          errors: item.errors,
          documentCount: item.documentCount,
          truncated: item.truncated,
        });
      }
    }
    return result;
  }
}

export const repoKnowledgeBaseService = new RepoKnowledgeBaseService();
