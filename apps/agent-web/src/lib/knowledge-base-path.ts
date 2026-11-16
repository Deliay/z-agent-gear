/**
 * 知识库文档路径纯函数（需求 #495 / 计划 §5.7）。
 *
 * 路径规则与服务端 `knowledge-base-service.normalizeDocumentPath` 同源：
 * trim → 必须以 `/` 开头 → 去末尾 `/`（根 `/` 除外）→ 拒绝控制字符/NUL →
 * 单段 ≤128 字符、全长 ≤512。前端只做体验收敛，**服务端始终是校验权威**。
 *
 * 浏览器路由 `/knowledge-bases/:kbId/*` 的 splat 承载文档路径：写入 URL 前逐段
 * `encodeURIComponent`（保留分隔 `/`），读取时逐段解码，非法百分号编码容忍为原文。
 */

export const DOC_PATH_MAX = 512;
export const DOC_PATH_SEGMENT_MAX = 128;

// 与服务端同一控制字符判定（NUL/C0/DEL）；该规则需要显式列控制字符范围
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * 归一化文档路径；非法返回 `null`（不抛错，便于表单内联提示）。
 * 合法示例：`/`、`/a`、`/a/b`；`/a/` → `/a`。
 */
export function normalizeDocumentPath(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  let value = raw.trim();
  if (!value.startsWith('/')) return null;
  if (value.length > 1) {
    value = value.replace(/\/+$/, '');
    if (value === '') value = '/';
  }
  if (value.length > DOC_PATH_MAX) return null;
  if (CONTROL_CHARS.test(value)) return null;
  if (value === '/') return value;
  const segments = value.slice(1).split('/');
  for (const segment of segments) {
    if (segment.length === 0 || segment.length > DOC_PATH_SEGMENT_MAX) return null;
  }
  return `/${segments.join('/')}`;
}

/** 父路径 + 名称拼成绝对路径（根路径拼接为 `/name`）。 */
export function joinDocPath(parentPath: string, name: string): string {
  const parent = normalizeDocumentPath(parentPath) ?? '/';
  const segment = name.trim().replace(/^\/+|\/+$/g, '');
  if (!segment) return parent;
  const joined = parent === '/' ? `/${segment}` : `${parent}/${segment}`;
  return normalizeDocumentPath(joined) ?? joined;
}

export interface DocBreadcrumb {
  /** 展示文案（根为「根目录」，其余为路径段） */
  label: string;
  /** 该面包屑对应的绝对路径 */
  path: string;
}

/** 面包屑：根目录起逐段累积（最后一段为当前文档路径）。 */
export function breadcrumbOf(path: string): DocBreadcrumb[] {
  const normalized = normalizeDocumentPath(path) ?? '/';
  const crumbs: DocBreadcrumb[] = [{ label: '根目录', path: '/' }];
  if (normalized === '/') return crumbs;
  let accumulated = '';
  for (const segment of normalized.slice(1).split('/')) {
    accumulated += `/${segment}`;
    crumbs.push({ label: segment, path: accumulated });
  }
  return crumbs;
}

export interface KnowledgeBaseTreeDoc {
  path: string;
  title: string;
}

export interface KnowledgeBaseTreeNode<T extends KnowledgeBaseTreeDoc = KnowledgeBaseTreeDoc> {
  /** 路径段名（虚拟目录节点用段名；文档节点展示标题请读 document.title） */
  name: string;
  /** 归一化后的绝对路径 */
  path: string;
  /** 该路径存在文档时携带（同一路径可同时是其他文档的父路径） */
  document?: T;
  children: KnowledgeBaseTreeNode<T>[];
}

/**
 * 按路径段聚合树：`/a/b`、`/a/c` → 根下 `a`（虚拟目录）→ `b`/`c` 文档。
 * 同级排序稳定：展示名（文档标题优先）字典序 → 路径 → 原数组顺序。
 */
export function buildKnowledgeBaseTree<T extends KnowledgeBaseTreeDoc>(
  documents: T[],
): KnowledgeBaseTreeNode<T>[] {
  const normalized = documents
    .map((document, index) => ({
      document,
      index,
      path: normalizeDocumentPath(document.path),
    }))
    .filter((item): item is { document: T; index: number; path: string } => item.path !== null)
    .sort(
      (a, b) =>
        a.path.localeCompare(b.path) ||
        a.document.title.localeCompare(b.document.title) ||
        a.index - b.index,
    );

  const roots: KnowledgeBaseTreeNode<T>[] = [];

  const sortNodes = (nodes: KnowledgeBaseTreeNode<T>[]): void => {
    nodes.sort((a, b) => {
      const aLabel = a.document?.title ?? a.name;
      const bLabel = b.document?.title ?? b.name;
      return aLabel.localeCompare(bLabel) || a.path.localeCompare(b.path);
    });
    for (const node of nodes) sortNodes(node.children);
  };

  for (const { document, path } of normalized) {
    if (path === '/') {
      let rootDoc = roots.find((node) => node.path === '/');
      if (!rootDoc) {
        rootDoc = { name: '/', path: '/', children: [] };
        roots.push(rootDoc);
      }
      rootDoc.document = document;
      continue;
    }

    const segments = path.slice(1).split('/');
    let current = roots;
    let accumulated = '';
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      accumulated += `/${segment}`;
      let node = current.find((item) => item.path === accumulated);
      if (!node) {
        node = { name: segment, path: accumulated, children: [] };
        current.push(node);
      }
      if (index === segments.length - 1) node.document = document;
      current = node.children;
    }
  }

  sortNodes(roots);
  return roots;
}

/** 新文档名：`新文档-{4 位随机小写字母/数字}`（标题与路径段同源）。 */
export function newDocumentName(): string {
  let suffix = Math.random().toString(36).slice(2, 6);
  while (suffix.length < 4) {
    suffix += Math.floor(Math.random() * 36).toString(36);
  }
  return `新文档-${suffix.slice(0, 4)}`;
}

/** 文档路径 → URL 路径（逐段编码，保留 `/`）。 */
export function encodeDocumentPath(path: string): string {
  const normalized = normalizeDocumentPath(path) ?? '/';
  if (normalized === '/') return '/';
  return `/${normalized
    .slice(1)
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')}`;
}

/** URL splat → 文档绝对路径（逐段解码；非法编码保留原文）。 */
export function decodeDocumentPath(splat: string | undefined | null): string {
  const raw = (splat ?? '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!raw) return '/';
  const segments = raw.split('/').map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
  return `/${segments.join('/')}`;
}

/** 知识库路由：`/knowledge-bases/{kbId}{encodedPath}`。 */
export function knowledgeBaseDocHref(kbId: string, path: string, edit = false): string {
  const base = `/knowledge-bases/${kbId}${encodeDocumentPath(path)}`;
  return edit ? `${base}?edit=1` : base;
}
