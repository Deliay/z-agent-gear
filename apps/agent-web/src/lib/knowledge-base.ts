/**
 * 知识库错误文案映射与展示常量（计划 D12）。
 *
 * 服务端契约错误为白名单逐字透传（`contracts/knowledge-base.graphql` 头注释），
 * 本文件只做中文映射；**未命中的文案原样展示**。服务端始终是权限与校验权威。
 */

export const KNOWLEDGE_BASE_ERROR_MESSAGES: Record<string, string> = {
  'knowledge base not found': '知识库不存在或你没有访问权限',
  'knowledge base name already exists': '当前工作区已存在同名知识库',
  'invalid knowledge base name': '知识库名称格式不正确（1~64 个字符）',
  'not a tenant admin': '仅租户管理员可以创建知识库',
  'knowledge base permission denied': '没有执行该操作的权限',
  'knowledge base document not found': '文档不存在或已被删除',
  'knowledge base document already exists': '该路径已存在文档',
  'invalid document path': '文档路径不合法（需以 / 开头、无空路径段）',
  'invalid document title': '标题格式不正确（1~200 个字符）',
  'invalid document tags': '标签格式不正确（最多 16 个，每个 1~32 字符）',
  'invalid document description': '描述最多 1024 个字符',
  'invalid document content': '内容最多 262144 个字符',
  'invalid knowledge base permission mode': '权限模式不合法',
  'workspace not found': '当前工作区不存在或已失效',
  'Not authenticated': '请先登录',
};

export function knowledgeBaseErrorMessage(
  error: unknown,
  fallback = '操作失败，请稍后重试',
): string {
  if (error instanceof Error && error.message) {
    const message = error.message.trim();
    return KNOWLEDGE_BASE_ERROR_MESSAGES[message] ?? message;
  }
  return fallback;
}

export const KNOWLEDGE_BASE_PERMISSION_MODES = [
  'NONE',
  'READ_ONLY',
  'UPDATE_ONLY',
  'FULL_ACCESS',
] as const;

export type KnowledgeBasePermissionMode = (typeof KNOWLEDGE_BASE_PERMISSION_MODES)[number];

export const PERMISSION_MODE_LABELS: Record<KnowledgeBasePermissionMode, string> = {
  NONE: '仅管理员可见',
  READ_ONLY: '非管理员只读',
  UPDATE_ONLY: '可读、可创建、可更新（不可删除）',
  FULL_ACCESS: '非管理员可读、可创建、可更新、可删除',
};

export const PERMISSION_MODE_DESCRIPTIONS: Record<KnowledgeBasePermissionMode, string> = {
  NONE: '非管理员完全不可见，也不可访问',
  READ_ONLY: '非管理员可查看列表、预览与历史，不可修改',
  UPDATE_ONLY: '非管理员可创建与更新文档，不可删除',
  FULL_ACCESS: '非管理员拥有完整文档 CRUD 权限',
};

/** 文档事件操作类型中文标签（历史抽屉/设置页全库历史共用）。 */
export const EVENT_OP_LABELS: Record<'CREATE' | 'UPDATE' | 'DELETE' | 'MOVE', string> = {
  CREATE: '创建',
  UPDATE: '更新',
  DELETE: '删除',
  MOVE: '移动',
};
