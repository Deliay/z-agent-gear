import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

/**
 * 项目仓库内建知识库扫描（契约 agent-session-websocket.md §3.29/§3.30）。
 *
 * 仓库为知识库唯一事实源：仅直读 `<workspacePath>/.zag/knowledges/`、
 * `<workspacePath>/docs/knowledges/` 与 `<workspacePath>/docs/` 的一层文件夹（来源 `docs-root`，
 * 跳过 `docs/knowledges` 容器）。知识库发现不递归（仅直接子文件夹，
 * 含常规文件 `knowledge-base.json` 即识别），库内文档递归收集 `.md` 常规文件并读取内容。
 * 仅读不写、不执行；不使用会话路径白名单。
 *
 * 上限（与 agent-api 编写指引 `knowledge-base-prompts.ts` 同源，二期口径）：
 * 单文件（`knowledge-base.json` 与 `.md`）1MiB / 单文件夹直接子项（目录与文件合计）1000；
 * 无知识库数、文档数与内容累计总量限制。truncated 按「文件夹 → 知识库 → 来源 → 整体」逐级上浮。
 */

export const REPO_KNOWLEDGE_BASE_SOURCES = [
  { source: 'zag', subdir: '.zag/knowledges' },
  { source: 'docs', subdir: 'docs/knowledges' },
  // 仓库 docs/ 的一层文件夹（跳过既有 docs/knowledges 容器目录）
  { source: 'docs-root', subdir: 'docs', excludeFolders: ['knowledges'] },
] as const;

export type RepoKnowledgeBaseSource = (typeof REPO_KNOWLEDGE_BASE_SOURCES)[number]['source'];

/** 单文件读取上限（字节）：`knowledge-base.json` 与 `.md` 同值 */
export const MAX_FILE_BYTES = 1024 * 1024;
/** 每个文件夹直接子项上限（目录与文件合计） */
export const MAX_ENTRIES_PER_FOLDER = 1000;

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
async function collectMarkdownFiles(
  baseDir: string,
): Promise<{ files: DocCandidate[]; truncated: boolean }> {
  const files: DocCandidate[] = [];
  let truncated = false;

  const walk = async (dir: string, prefix: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // 已知口径：子目录不可读按空目录处理（与「目录不存在」一致），不使整库不合法；
      // 单文档读取失败才逐条剔除。避免仓库权限细节放大为库级错误。
      return;
    }
    // 每层按名称排序后取前 1000（目录与文件合计），超出部分不遍历（二期 D3）
    entries.sort((a, b) => a.name.localeCompare(b.name));
    if (entries.length > MAX_ENTRIES_PER_FOLDER) {
      entries = entries.slice(0, MAX_ENTRIES_PER_FOLDER);
      truncated = true;
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
          if (target.isFile()) files.push({ fullPath, relPath });
        } catch {
          // 悬空/不可解析的符号链接：跳过
        }
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        files.push({ fullPath, relPath });
      }
    }
  };

  await walk(baseDir, '');
  return { files, truncated };
}

async function scanKnowledgeBase(
  sourceDir: string,
  folder: string,
): Promise<KnowledgeBaseEntry> {
  const baseDir = join(sourceDir, folder);
  const schemaPath = join(baseDir, KNOWLEDGE_BASE_IDENTIFIER_FILE);

  let schemaInfo;
  try {
    schemaInfo = await stat(schemaPath);
  } catch {
    // 已知口径：stat 失败无法区分「不存在」与「不可访问」，统一视为非知识库文件夹
    // （与「无 knowledge-base.json」同结果）；区别于 schema readFile 失败会上报 error。
    return { folder };
  }
  // 仅常规文件（或指向常规文件的符号链接）才识别为知识库
  if (!schemaInfo.isFile()) return { folder };

  if (schemaInfo.size > MAX_FILE_BYTES) {
    return { folder, error: 'file too large' };
  }

  let schema: string;
  try {
    schema = await readFile(schemaPath, { encoding: 'utf8' });
  } catch (err) {
    return { folder, error: mapFileError(err) };
  }
  const schemaBytes = Buffer.byteLength(schema, 'utf8');
  if (schemaBytes > MAX_FILE_BYTES) {
    return { folder, error: 'file too large' };
  }

  const collected = await collectMarkdownFiles(baseDir);
  const candidates = collected.files.sort((a, b) => a.relPath.localeCompare(b.relPath));

  const documents: KnowledgeBaseDocumentFile[] = [];
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate.fullPath);
      if (info.size > MAX_FILE_BYTES) {
        // 不读内容；单篇超限不影响后续文档（保留条目并附白名单文案）
        documents.push({ path: candidate.relPath, error: 'file too large' });
        continue;
      }
      const content = await readFile(candidate.fullPath, { encoding: 'utf8' });
      // 读后复核（防 stat 失真）；超限仍保留条目、不返回内容
      if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
        documents.push({ path: candidate.relPath, error: 'file too large' });
        continue;
      }
      documents.push({ path: candidate.relPath, content });
    } catch (err) {
      documents.push({ path: candidate.relPath, error: mapFileError(err) });
    }
  }

  return { folder, schema, documents, truncated: collected.truncated };
}

async function scanSource(
  workspacePath: string,
  source: RepoKnowledgeBaseSource,
  subdir: string,
  excludeFolders: readonly string[] = [],
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

  const ordered = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  // 来源目录层与库内目录层同构：直接子项（目录与文件合计）按名称取前 1000，
  // 窗口外不遍历并置来源 truncated；再从窗口内筛选目录/目录符号链接作为知识库候选。
  let truncated = false;
  if (ordered.length > MAX_ENTRIES_PER_FOLDER) {
    ordered.length = MAX_ENTRIES_PER_FOLDER;
    truncated = true;
  }

  const folders: string[] = [];
  for (const entry of ordered) {
    // 已知容器目录（docs-root 的 docs/knowledges）：不参与知识库发现
    if (excludeFolders.includes(entry.name)) continue;
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

  const knowledgeBases: KnowledgeBaseEntry[] = [];
  for (const folder of folders) {
    const entry = await scanKnowledgeBase(sourceDir, folder);
    // 未识别为知识库（无 knowledge-base.json）的文件夹不输出
    if (entry.schema === undefined && entry.error === undefined) continue;
    if (entry.truncated) truncated = true;
    knowledgeBases.push(entry);
  }

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
    const result = await scanSource(
      workspacePath,
      item.source,
      item.subdir,
      'excludeFolders' in item ? item.excludeFolders : [],
    );
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
