import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

/**
 * 项目仓库内建知识库扫描（契约 agent-session-websocket.md §3.29/§3.30）。
 *
 * 仓库为知识库唯一事实源：仅直读 `<workspacePath>/.zag/knowledges/` 与
 * `<workspacePath>/docs/knowledges/` 两个固定子目录。知识库发现不递归（仅直接子文件夹，
 * 含常规文件 `knowledge-base.json` 即识别），库内文档递归收集 `.md` 常规文件并读取内容。
 * 仅读不写、不执行；不使用会话路径白名单。
 *
 * 上限（与 agent-api 编写指引 `knowledge-base-prompts.ts` 同源）：
 * 每来源 20 个知识库 / 每库 50 个文档 / schema 64KiB / 单文档 128KiB /
 * 单库内容累计 1MiB / 单来源内容累计 2MiB。
 */

export const REPO_KNOWLEDGE_BASE_SOURCES = [
  { source: 'zag', subdir: '.zag/knowledges' },
  { source: 'docs', subdir: 'docs/knowledges' },
] as const;

export type RepoKnowledgeBaseSource = (typeof REPO_KNOWLEDGE_BASE_SOURCES)[number]['source'];

/** 每个来源目录最多识别的知识库数 */
export const MAX_KNOWLEDGE_BASES_PER_SOURCE = 20;
/** 每个知识库最多收集的文档数 */
export const MAX_DOCUMENTS_PER_BASE = 50;
/** knowledge-base.json 读取上限（字节） */
export const MAX_SCHEMA_BYTES = 64 * 1024;
/** 单文档读取上限（字节） */
export const MAX_DOCUMENT_BYTES = 128 * 1024;
/** 单知识库内容累计上限（字节） */
export const MAX_BASE_TOTAL_BYTES = 1024 * 1024;
/** 单来源内容累计上限（字节） */
export const MAX_SOURCE_TOTAL_BYTES = 2 * 1024 * 1024;

export const KNOWLEDGE_BASE_IDENTIFIER_FILE = 'knowledge-base.json';

export interface KnowledgeBaseDocumentFile {
  /** 库内相对 POSIX 路径 */
  path: string;
  content?: string;
  /** 白名单文案：file too large / not found / permission denied */
  error?: string;
}

export interface KnowledgeBaseEntry {
  folder: string;
  schema?: string;
  documents?: KnowledgeBaseDocumentFile[];
  truncated?: boolean;
  /** 该库整体失败原因（白名单文案） */
  error?: string;
}

export interface KnowledgeBaseSourceResult {
  source: RepoKnowledgeBaseSource;
  knowledgeBases: KnowledgeBaseEntry[];
  truncated: boolean;
}

export interface KnowledgeBaseScanResult {
  success: boolean;
  sources: KnowledgeBaseSourceResult[];
  truncated: boolean;
  /** 整体失败原因（白名单文案：file too large / not found / permission denied） */
  error?: string;
}

interface DocCandidate {
  fullPath: string;
  relPath: string;
}

function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code?: unknown }).code)
    : undefined;
}

/** 文件级错误归一为契约白名单文案 */
function mapFileError(err: unknown): string {
  const code = errorCode(err);
  if (code === 'EACCES' || code === 'EPERM') return 'permission denied';
  if (code === 'EFBIG' || code === 'ERR_FS_FILE_TOO_LARGE') return 'file too large';
  return 'not found';
}

function toPosixPath(value: string): string {
  return sep === '/' ? value : value.split(sep).join('/');
}

/** 递归收集 `.md` 常规文件（符号链接仅接受指向常规文件的链接；目录链接不跟随）。 */
async function collectMarkdownFiles(baseDir: string): Promise<DocCandidate[]> {
  const result: DocCandidate[] = [];

  const walk = async (dir: string, prefix: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(fullPath, relPath);
        continue;
      }
      if (entry.isSymbolicLink()) {
        if (!entry.name.toLowerCase().endsWith('.md')) continue;
        try {
          const target = await stat(fullPath);
          if (target.isFile()) result.push({ fullPath, relPath });
        } catch {
          // 悬空/不可解析的符号链接：跳过
        }
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        result.push({ fullPath, relPath });
      }
    }
  };

  await walk(baseDir, '');
  return result;
}

interface SourceScanState {
  sourceBytes: number;
  truncated: boolean;
}

async function scanKnowledgeBase(
  sourceDir: string,
  folder: string,
  state: SourceScanState,
): Promise<KnowledgeBaseEntry> {
  const baseDir = join(sourceDir, folder);
  const schemaPath = join(baseDir, KNOWLEDGE_BASE_IDENTIFIER_FILE);

  let schemaInfo;
  try {
    schemaInfo = await stat(schemaPath);
  } catch {
    return { folder };
  }
  // 仅常规文件（或指向常规文件的符号链接）才识别为知识库
  if (!schemaInfo.isFile()) return { folder };

  if (schemaInfo.size > MAX_SCHEMA_BYTES) {
    return { folder, error: 'file too large' };
  }

  let schema: string;
  try {
    schema = await readFile(schemaPath, { encoding: 'utf8' });
  } catch (err) {
    return { folder, error: mapFileError(err) };
  }
  const schemaBytes = Buffer.byteLength(schema, 'utf8');
  if (schemaBytes > MAX_SCHEMA_BYTES) {
    return { folder, error: 'file too large' };
  }

  const candidates = (await collectMarkdownFiles(baseDir)).sort((a, b) =>
    a.relPath.localeCompare(b.relPath),
  );

  let truncated = false;
  if (candidates.length > MAX_DOCUMENTS_PER_BASE) {
    candidates.length = MAX_DOCUMENTS_PER_BASE;
    truncated = true;
  }

  const documents: KnowledgeBaseDocumentFile[] = [];
  let baseBytes = 0;

  for (const candidate of candidates) {
    if (state.truncated) break;
    try {
      const info = await stat(candidate.fullPath);
      if (info.size > MAX_DOCUMENT_BYTES) {
        // 不读内容；单篇超限不影响后续文档
        documents.push({ path: candidate.relPath, error: 'file too large' });
        continue;
      }
      if (baseBytes + info.size > MAX_BASE_TOTAL_BYTES) {
        truncated = true;
        break;
      }
      if (state.sourceBytes + info.size > MAX_SOURCE_TOTAL_BYTES) {
        state.truncated = true;
        break;
      }
      const content = await readFile(candidate.fullPath, { encoding: 'utf8' });
      const bytes = Buffer.byteLength(content, 'utf8');
      if (baseBytes + bytes > MAX_BASE_TOTAL_BYTES) {
        truncated = true;
        break;
      }
      if (state.sourceBytes + bytes > MAX_SOURCE_TOTAL_BYTES) {
        state.truncated = true;
        break;
      }
      baseBytes += bytes;
      state.sourceBytes += bytes;
      documents.push({ path: candidate.relPath, content });
    } catch (err) {
      documents.push({ path: candidate.relPath, error: mapFileError(err) });
    }
  }

  return { folder, schema, documents, truncated };
}

async function scanSource(
  workspacePath: string,
  source: RepoKnowledgeBaseSource,
  subdir: string,
): Promise<KnowledgeBaseSourceResult | null> {
  const sourceDir = resolve(workspacePath, subdir);

  let entries;
  try {
    entries = await readdir(sourceDir, { withFileTypes: true });
  } catch (err) {
    const code = errorCode(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { source, knowledgeBases: [], truncated: false };
    }
    // 权限失败/其它读取异常：整体失败（由调用方归一为白名单文案）
    return null;
  }

  const folders: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      folders.push(entry.name);
      continue;
    }
    if (!entry.isSymbolicLink()) continue;
    try {
      const target = await stat(join(sourceDir, entry.name));
      if (target.isDirectory()) folders.push(entry.name);
    } catch {
      // 悬空/不可解析的符号链接：跳过
    }
  }

  folders.sort((a, b) => a.localeCompare(b));
  let truncated = false;
  if (folders.length > MAX_KNOWLEDGE_BASES_PER_SOURCE) {
    folders.length = MAX_KNOWLEDGE_BASES_PER_SOURCE;
    truncated = true;
  }

  const state: SourceScanState = { sourceBytes: 0, truncated: false };
  const knowledgeBases: KnowledgeBaseEntry[] = [];
  for (const folder of folders) {
    if (state.truncated) {
      truncated = true;
      break;
    }
    const entry = await scanKnowledgeBase(sourceDir, folder, state);
    // 未识别为知识库（无 knowledge-base.json）的文件夹不输出
    if (entry.schema === undefined && entry.error === undefined) continue;
    if (entry.truncated) truncated = true;
    knowledgeBases.push(entry);
  }
  if (state.truncated) truncated = true;

  return { source, knowledgeBases, truncated };
}

/**
 * 扫描项目仓库内建知识库目录。
 *
 * - 目录不存在（ENOENT / ENOTDIR）→ 该来源空列表且 `success: true`
 * - 任一来源目录读取权限失败 → `{ success: false, sources: [], truncated: false, error: 'permission denied' }`
 * - 符号链接按 `stat` 判定：目录发现接受指向目录的链接，文档仅接受指向常规文件的链接
 */
export async function scanKnowledgeBases(
  workspacePath: string,
): Promise<KnowledgeBaseScanResult> {
  const sources: KnowledgeBaseSourceResult[] = [];
  for (const item of REPO_KNOWLEDGE_BASE_SOURCES) {
    const result = await scanSource(workspacePath, item.source, item.subdir);
    if (!result) {
      return { success: false, sources: [], truncated: false, error: 'permission denied' };
    }
    sources.push(result);
  }
  return {
    success: true,
    sources,
    truncated: sources.some((item) => item.truncated),
  };
}
