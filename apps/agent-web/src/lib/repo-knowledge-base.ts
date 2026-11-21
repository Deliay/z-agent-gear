/**
 * 仓库内建知识库 id 编解码（与服务端 `repo-knowledge-bases.ts` 同口径）。
 *
 * id 形态：`repo:<workspaceId>:<source>:<encodeURIComponent(folder)>`，
 * source ∈ `zag | docs | docs-root`；仅以 `repo:` 前缀与平台知识库 ObjectId 区分。
 */

export type RepoKnowledgeBaseSource = 'ZAG' | 'DOCS' | 'DOCS_ROOT';

export interface DecodedRepoKnowledgeBaseId {
  workspaceId: string;
  source: RepoKnowledgeBaseSource;
  folder: string;
}

const SOURCE_BY_RAW: Record<string, RepoKnowledgeBaseSource> = {
  zag: 'ZAG',
  docs: 'DOCS',
  'docs-root': 'DOCS_ROOT',
};

export function isRepoKnowledgeBaseId(id: string): boolean {
  return typeof id === 'string' && id.startsWith('repo:');
}

export function decodeRepoKnowledgeBaseId(id: string): DecodedRepoKnowledgeBaseId | null {
  if (!isRepoKnowledgeBaseId(id)) return null;
  const rest = id.slice('repo:'.length);
  const first = rest.indexOf(':');
  if (first <= 0) return null;
  const workspaceId = rest.slice(0, first);
  const rest2 = rest.slice(first + 1);
  const second = rest2.indexOf(':');
  if (second <= 0) return null;
  const source = SOURCE_BY_RAW[rest2.slice(0, second)];
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

/** 来源目录展示标识 */
export function sourceLabel(source: RepoKnowledgeBaseSource): string {
  switch (source) {
    case 'ZAG':
      return '.zag/knowledges';
    case 'DOCS':
      return 'docs/knowledges';
    case 'DOCS_ROOT':
      return 'docs（一层文件夹）';
  }
}
