import { McpServer } from '../models/mcp-server.js';
import { knowledgeBaseService } from './knowledge-base-service.js';
import { getWorkspaceContext } from './workspace-context.js';

/**
 * 平台内置 MCP `agent-knowledge-base-tools`（需求 #495 / 提案 §5.2 实现点 3）。
 *
 * - 六工具：`knowledge_base_create` / `knowledge_base_list` /
 *   `knowledge_base_document_list` / `knowledge_base_document_get` /
 *   `knowledge_base_document_update`（upsert）/ `knowledge_base_document_delete`；
 * - **双校验**：`tools/list` 按会话创建人角色门控 `knowledge_base_create`（非 admin 不出现），
 *   `tools/call` 再次委托服务层判定（防绕过门控直接构造调用）；
 * - 可见范围 = 会话工作区 ∪ 本租户全局工作区 × 四档权限矩阵（与 GraphQL 同口径，
 *   权限唯一事实源仍是 `knowledge-base-access`）；
 * - 库定位：`knowledgeBaseId` 优先，缺省用 `knowledgeBaseName` 在**可见集内**解析
 *   （0 命中/多命中 → isError 明确提示，提案 D10）；
 * - 错误形态统一 `content[0].text + isError:true`（白名单文案逐字），未知方法/工具 →
 *   JSON-RPC `METHOD_NOT_FOUND`。
 */

export const KNOWLEDGE_BASE_TOOLS_SERVER_NAME = 'agent-knowledge-base-tools';

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const KB_LOCATOR_PROPERTIES = {
  knowledgeBaseId: {
    type: 'string',
    description: '知识库 id（优先于 knowledgeBaseName）',
  },
  knowledgeBaseName: {
    type: 'string',
    description: '知识库名称（在可见集内解析；仅当未提供 knowledgeBaseId 时使用）',
  },
};

export const KNOWLEDGE_BASE_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'knowledge_base_create',
    description: '创建知识库（仅租户管理员；默认权限模式按工作区类型：全局 READ_ONLY、普通 NONE）',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '知识库名称（1~64 字符，工作区内唯一）' },
      },
      required: ['name'],
    },
  },
  {
    name: 'knowledge_base_list',
    description: '列出当前会话可见的知识库（本工作区 ∪ 本租户全局工作区，按权限模式过滤）',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'knowledge_base_document_list',
    description: '列出知识库内文档路径与元信息（标题/标签/描述/更新时间，不含内容；可按路径前缀过滤）',
    inputSchema: {
      type: 'object',
      properties: {
        ...KB_LOCATOR_PROPERTIES,
        prefix: { type: 'string', description: '路径前缀（缺省 = 全库）' },
      },
    },
  },
  {
    name: 'knowledge_base_document_get',
    description: '按路径获取知识库文档完整内容（不可见/无读权限/不存在均返回文档不存在）',
    inputSchema: {
      type: 'object',
      properties: {
        ...KB_LOCATOR_PROPERTIES,
        path: { type: 'string', description: '文档路径（以 / 开头，库内唯一）' },
      },
      required: ['path'],
    },
  },
  {
    name: 'knowledge_base_document_update',
    description:
      '更新知识库文档（路径不存在时创建）：传入知识库 + 路径与标题/标签/描述/内容；' +
      '可选 newPath 在源文档存在时原子「移动 + 更新」（历史随文档带入新路径）；权限按库模式判定',
    inputSchema: {
      type: 'object',
      properties: {
        ...KB_LOCATOR_PROPERTIES,
        path: { type: 'string', description: '文档路径（以 / 开头，库内唯一）' },
        newPath: {
          type: 'string',
          description: '新文档路径（移动，可选；仅当 path 指向已存在文档时生效）',
        },
        title: { type: 'string', description: '标题（1~200 字符）' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签（≤16 个，每个 1~32 字符）' },
        description: { type: 'string', description: '描述（≤1024 字符，可空）' },
        content: { type: 'string', description: 'Markdown 内容（≤262144 字符）' },
      },
      required: ['path', 'title', 'tags', 'description', 'content'],
    },
  },
  {
    name: 'knowledge_base_document_delete',
    description: '删除知识库文档（释放路径；历史事件保留）',
    inputSchema: {
      type: 'object',
      properties: {
        ...KB_LOCATOR_PROPERTIES,
        path: { type: 'string', description: '文档路径（以 / 开头，库内唯一）' },
      },
      required: ['path'],
    },
  },
];

/** 幂等 upsert 平台知识库工具服务，返回其 _id（对齐 ensureValutToolsServer 形态）。 */
export async function ensureKnowledgeBaseToolsServer(userId: string): Promise<string> {
  try {
    const server = await McpServer.findOneAndUpdate(
      { userId, name: KNOWLEDGE_BASE_TOOLS_SERVER_NAME },
      {
        $setOnInsert: {
          userId,
          name: KNOWLEDGE_BASE_TOOLS_SERVER_NAME,
          transport: 'platform',
          source: 'platform',
          enabled: true,
          tools: KNOWLEDGE_BASE_TOOL_DEFINITIONS.map((tool) => ({
            name: tool.name,
            description: tool.description,
          })),
        },
      },
      { upsert: true, returnDocument: 'after' },
    );
    return server._id.toString();
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code: number }).code === 11000) {
      const existing = await McpServer.findOne({
        userId,
        name: KNOWLEDGE_BASE_TOOLS_SERVER_NAME,
      }).lean();
      if (existing) return existing._id.toString();
    }
    throw err;
  }
}

export interface KnowledgeBaseToolCaller {
  userId: string;
  sessionId: string;
}

export type KnowledgeBaseToolResult =
  | { result?: unknown; error?: { code: string; message: string } };

/** 契约白名单（与 resolvers/knowledge-base.ts 同集合；未命中收敛 internal error）。 */
const PUBLIC_ERRORS = new Set([
  'workspace not found',
  'knowledge base not found',
  'knowledge base name already exists',
  'invalid knowledge base name',
  'not a tenant admin',
  'knowledge base permission denied',
  'knowledge base document not found',
  'knowledge base document already exists',
  'invalid document path',
  'invalid document title',
  'invalid document tags',
  'invalid document description',
  'invalid document content',
]);

function ok(payload: unknown): KnowledgeBaseToolResult {
  return { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } };
}

function fail(message: string): KnowledgeBaseToolResult {
  return { result: { content: [{ type: 'text', text: message }], isError: true } };
}

function toToolFailure(err: unknown): KnowledgeBaseToolResult {
  if (err instanceof ToolFailure) return fail(err.message);
  const message = err instanceof Error ? err.message : String(err);
  return fail(PUBLIC_ERRORS.has(message) ? message : 'internal error');
}

/** 工具层入参/定位错误：直接以明确提示回给 Agent（不收敛 internal error）。 */
class ToolFailure extends Error {}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** 库定位：id 优先；缺省按名称在可见集内解析（0/多命中明确报错）。 */
async function resolveKnowledgeBaseId(
  userId: string,
  args: Record<string, unknown>,
): Promise<string> {
  const directId = asString(args.knowledgeBaseId)?.trim();
  if (directId) return directId;
  const name = asString(args.knowledgeBaseName)?.trim();
  if (!name) throw new ToolFailure('knowledgeBaseId or knowledgeBaseName is required');
  const visible = await knowledgeBaseService.list(userId);
  const matches = visible.filter((item) => item.name === name);
  if (matches.length === 0) throw new ToolFailure(`knowledge base not found: ${name}`);
  if (matches.length > 1) {
    throw new ToolFailure(
      `multiple knowledge bases named "${name}" (${matches.length}); please pass knowledgeBaseId`,
    );
  }
  return matches[0].id;
}

function documentInputFromArgs(args: Record<string, unknown>) {
  return {
    title: args.title as string,
    tags: args.tags as string[],
    description: args.description as string,
    content: args.content as string,
  };
}

/** 平台 MCP `agent-knowledge-base-tools` 本地分发。 */
export async function handleKnowledgeBaseToolsMcpRequest(
  caller: KnowledgeBaseToolCaller,
  request: {
    method?: string;
    params?: { name?: string; arguments?: Record<string, unknown> };
  },
): Promise<KnowledgeBaseToolResult> {
  switch (request.method) {
    case 'initialize':
      return {
        result: {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: KNOWLEDGE_BASE_TOOLS_SERVER_NAME, version: '1.0.0' },
        },
      };
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return { result: {} };
    case 'ping':
      return { result: {} };
    case 'tools/list': {
      // 会话上下文已由 mcp-dispatch 的 runWithWorkspace 注入；无上下文按非 admin 收紧
      const isAdmin = getWorkspaceContext()?.role === 'admin';
      return {
        result: {
          tools: KNOWLEDGE_BASE_TOOL_DEFINITIONS.filter(
            (tool) => isAdmin || tool.name !== 'knowledge_base_create',
          ),
        },
      };
    }
    case 'tools/call': {
      const toolName = request.params?.name;
      if (!toolName) {
        return { error: { code: 'INVALID_PARAMS', message: 'tools/call 缺少 params.name' } };
      }
      const args = request.params?.arguments ?? {};
      try {
        switch (toolName) {
          case 'knowledge_base_create': {
            if (getWorkspaceContext()?.role !== 'admin') throw new Error('not a tenant admin');
            const created = await knowledgeBaseService.create(
              caller.userId,
              args.name as string,
            );
            return ok({
              id: created.id,
              name: created.name,
              permissionMode: created.permissionMode,
              global: created.global,
            });
          }
          case 'knowledge_base_list': {
            const bases = await knowledgeBaseService.list(caller.userId);
            return ok(
              bases.map((item) => ({
                id: item.id,
                name: item.name,
                global: item.global,
                permissionMode: item.permissionMode,
                myAccess: item.myAccess,
              })),
            );
          }
          case 'knowledge_base_document_list': {
            const kbId = await resolveKnowledgeBaseId(caller.userId, args);
            const docs = await knowledgeBaseService.listDocuments(
              caller.userId,
              kbId,
              asString(args.prefix),
            );
            return ok(
              docs.map((doc) => ({
                path: doc.path,
                title: doc.title,
                tags: doc.tags,
                description: doc.description,
                updatedAt: doc.updatedAt,
              })),
            );
          }
          case 'knowledge_base_document_get': {
            const kbId = await resolveKnowledgeBaseId(caller.userId, args);
            const doc = await knowledgeBaseService.getDocument(
              caller.userId,
              kbId,
              args.path as string,
            );
            if (!doc) throw new Error('knowledge base document not found');
            return ok({
              path: doc.path,
              title: doc.title,
              tags: doc.tags,
              description: doc.description,
              content: doc.content,
              createdByName: doc.createdByName,
              updatedByName: doc.updatedByName,
              createdAt: doc.createdAt,
              updatedAt: doc.updatedAt,
            });
          }
          case 'knowledge_base_document_update': {
            const kbId = await resolveKnowledgeBaseId(caller.userId, args);
            const doc = await knowledgeBaseService.upsertDocument(
              caller.userId,
              kbId,
              args.path as string,
              documentInputFromArgs(args),
              asString(args.newPath),
            );
            return ok({
              path: doc.path,
              title: doc.title,
              tags: doc.tags,
              description: doc.description,
              content: doc.content,
              createdByName: doc.createdByName,
              updatedByName: doc.updatedByName,
              createdAt: doc.createdAt,
              updatedAt: doc.updatedAt,
            });
          }
          case 'knowledge_base_document_delete': {
            const kbId = await resolveKnowledgeBaseId(caller.userId, args);
            await knowledgeBaseService.deleteDocument(
              caller.userId,
              kbId,
              args.path as string,
            );
            return ok({ success: true });
          }
          default:
            return { error: { code: 'METHOD_NOT_FOUND', message: `未知工具：${toolName}` } };
        }
      } catch (err) {
        return toToolFailure(err);
      }
    }
    default:
      return { error: { code: 'METHOD_NOT_FOUND', message: `不支持的方法：${request.method}` } };
  }
}
