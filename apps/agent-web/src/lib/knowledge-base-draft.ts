/**
 * 知识库文档草稿缓存（需求 #495 / 计划 §5.7 / PRD 功能点 3）。
 *
 * - 键：`kb-doc-draft:{kbId}:{path}`（不同文档互不干扰）。
 * - 编辑输入防抖 300ms 写入；保存成功清除（清除同时取消在途计时器，避免「保存后被迟到草稿覆盖」）。
 * - 读取容错：JSON 解析失败 / 形状非法一律按无缓存处理，不阻塞进入编辑。
 */

export const DRAFT_KEY_PREFIX = 'kb-doc-draft';
export const DRAFT_DEBOUNCE_MS = 300;

export interface KnowledgeBaseDraftInput {
  title: string;
  tags: string[];
  description: string;
  content: string;
  /** 编辑中的文档路径（#541：路径可修改；缺省兼容旧草稿，恢复时回退当前路径） */
  editedPath?: string;
}

export interface KnowledgeBaseDraft extends KnowledgeBaseDraftInput {
  /** 草稿写入时间（ISO） */
  updatedAt: string;
}

function getStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function documentDraftKey(kbId: string, path: string): string {
  return `${DRAFT_KEY_PREFIX}:${kbId}:${path}`;
}

function isDraft(value: unknown): value is KnowledgeBaseDraft {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.title === 'string' &&
    Array.isArray(candidate.tags) &&
    candidate.tags.every((tag) => typeof tag === 'string') &&
    typeof candidate.description === 'string' &&
    typeof candidate.content === 'string' &&
    typeof candidate.updatedAt === 'string' &&
    (candidate.editedPath === undefined || typeof candidate.editedPath === 'string')
  );
}

/** 读取草稿；不存在/损坏/形状非法 → null。 */
export function readDocumentDraft(kbId: string, path: string): KnowledgeBaseDraft | null {
  const storage = getStorage();
  if (!storage) return null;
  let parsed: unknown;
  try {
    const raw = storage.getItem(documentDraftKey(kbId, path));
    if (!raw) return null;
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isDraft(parsed)) return null;
  return {
    title: parsed.title,
    tags: [...parsed.tags],
    description: parsed.description,
    content: parsed.content,
    ...(parsed.editedPath === undefined ? {} : { editedPath: parsed.editedPath }),
    updatedAt: parsed.updatedAt,
  };
}

/** 立即写入草稿（内部与 flush 使用）。 */
export function writeDocumentDraft(
  kbId: string,
  path: string,
  draft: KnowledgeBaseDraftInput,
): KnowledgeBaseDraft | null {
  const storage = getStorage();
  if (!storage) return null;
  const record: KnowledgeBaseDraft = {
    title: draft.title,
    tags: [...draft.tags],
    description: draft.description,
    content: draft.content,
    ...(draft.editedPath === undefined ? {} : { editedPath: draft.editedPath }),
    updatedAt: new Date().toISOString(),
  };
  try {
    storage.setItem(documentDraftKey(kbId, path), JSON.stringify(record));
  } catch {
    // localStorage 不可写（隐私模式/配额）时静默降级为不缓存
    return null;
  }
  return record;
}

const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingDrafts = new Map<string, KnowledgeBaseDraftInput>();

function cancelTimer(key: string): void {
  const timer = pendingTimers.get(key);
  if (timer !== undefined) {
    clearTimeout(timer);
    pendingTimers.delete(key);
  }
}

/** 防抖写入（300ms）；同一文档的连续输入只落最后一次。 */
export function scheduleDocumentDraft(
  kbId: string,
  path: string,
  draft: KnowledgeBaseDraftInput,
): void {
  const key = documentDraftKey(kbId, path);
  pendingDrafts.set(key, {
    title: draft.title,
    tags: [...draft.tags],
    description: draft.description,
    content: draft.content,
    ...(draft.editedPath === undefined ? {} : { editedPath: draft.editedPath }),
  });
  cancelTimer(key);
  const timer = setTimeout(() => {
    pendingTimers.delete(key);
    const pending = pendingDrafts.get(key);
    pendingDrafts.delete(key);
    if (pending) writeDocumentDraft(kbId, path, pending);
  }, DRAFT_DEBOUNCE_MS);
  // 测试环境（jsdom）下不阻塞进程退出
  (timer as { unref?: () => void }).unref?.();
  pendingTimers.set(key, timer);
}

/** 立刻落盘在途草稿（保存前/卸载前使用）。 */
export function flushDocumentDraft(kbId: string, path: string): void {
  const key = documentDraftKey(kbId, path);
  cancelTimer(key);
  const pending = pendingDrafts.get(key);
  pendingDrafts.delete(key);
  if (pending) writeDocumentDraft(kbId, path, pending);
}

/** 取消在途写入（不删除已落盘内容）。 */
export function cancelScheduledDocumentDraft(kbId: string, path: string): void {
  const key = documentDraftKey(kbId, path);
  cancelTimer(key);
  pendingDrafts.delete(key);
}

/** 保存成功清除草稿（同时取消在途计时器）。 */
export function clearDocumentDraft(kbId: string, path: string): void {
  cancelScheduledDocumentDraft(kbId, path);
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.removeItem(documentDraftKey(kbId, path));
  } catch {
    // 忽略不可写存储
  }
}

/** 测试隔离：清空全部计时器与在途草稿（不清理 localStorage）。 */
export function resetDraftScheduler(): void {
  for (const timer of pendingTimers.values()) clearTimeout(timer);
  pendingTimers.clear();
  pendingDrafts.clear();
}
