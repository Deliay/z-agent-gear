import { McpServer } from '../models/mcp-server.js';
import { customToolService, type CustomToolMcpEntry } from './custom-tool-service.js';
import { execute, toHttpToolError } from './custom-tool-http.js';
import { renderFragments, type RenderContext } from './fragment-render.js';
import { valutService } from './valut-service.js';
import { getWorkspaceContext } from './workspace-context.js';

/**
 * 平台内置 MCP `agent-custom-tools`（需求 #449 / 提案 §5.2 实现点 4）。
 *
 * - **动态目录**：`tools/list` 每次按会话工作区实时查询 `customtools`（无快照/缓存），
 *   增删改即时生效；删除后调用 `METHOD_NOT_FOUND`。
 * - **暴露名映射（D4）**：展示名命中 `^[A-Za-z0-9_-]{1,64}$` 直接用原名；否则用稳定别名
 *   `ct-<id 后 8 位>`；`description` 恒携带展示名（别名形态放首部）；`tools/call` 同规则反解。
 * - **调用**：暴露名反解 → 参数齐全校验（缺失 `INVALID_PARAMS` 并列名）→ params 归一 string
 *   → prompt 渲染返回 / http 服务端执行；失败 `isError:true` + 白名单文案（不回传密钥片段）。
 *
 * 安全红线：本模块不记录任何参数、渲染中间值与响应正文日志。
 */

export const CUSTOM_TOOLS_SERVER_NAME = 'agent-custom-tools';

const MCP_SAFE_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** 幂等 upsert 平台自定义工具服务；动态目录占位快照 `[]`（D3）。 */
export async function ensureCustomToolsServer(userId: string): Promise<string> {
  try {
    const server = await McpServer.findOneAndUpdate(
      { userId, name: CUSTOM_TOOLS_SERVER_NAME },
      {
        $setOnInsert: {
          userId,
          name: CUSTOM_TOOLS_SERVER_NAME,
          transport: 'platform',
          source: 'platform',
          enabled: true,
          tools: [],
        },
      },
      { upsert: true, returnDocument: 'after' },
    );
    return server._id.toString();
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code: number }).code === 11000) {
      const existing = await McpServer.findOne({ userId, name: CUSTOM_TOOLS_SERVER_NAME }).lean();
      if (existing) return existing._id.toString();
    }
    throw err;
  }
}

/** 暴露名（D4）：安全名直接用展示名，否则稳定别名 `ct-<id 后 8 位>`。 */
export function resolveExposedName(tool: { id: string; name: string }): string {
  if (MCP_SAFE_NAME_RE.test(tool.name)) return tool.name;
  return `ct-${tool.id.slice(-8)}`;
}

function describeTool(tool: CustomToolMcpEntry): string {
  const exposed = resolveExposedName(tool);
  const summary = tool.description ?? tool.name;
  return exposed === tool.name ? summary : `${tool.name} - ${summary}`;
}

function buildToolDefinition(tool: CustomToolMcpEntry): ToolDefinition {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const arg of tool.args) {
    properties[arg.key] = { type: 'string', description: arg.description ?? arg.name };
    required.push(arg.key);
  }
  return {
    name: resolveExposedName(tool),
    description: describeTool(tool),
    inputSchema: { type: 'object', properties, required },
  };
}

/** 暴露名反解：先按展示名精确匹配，未命中再按 `ct-<id8>` 别名。 */
export function findToolByExposedName(
  tools: CustomToolMcpEntry[],
  exposedName: string,
): CustomToolMcpEntry | undefined {
  return (
    tools.find((tool) => MCP_SAFE_NAME_RE.test(tool.name) && tool.name === exposedName) ??
    tools.find((tool) => resolveExposedName(tool) === exposedName)
  );
}

function normalizeParams(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    params[key] = typeof value === 'string' ? value : String(value);
  }
  return params;
}

function errorContent(message: string): { content: Array<{ type: string; text: string }>; isError: true } {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export interface CustomToolsCaller {
  userId: string;
  sessionId: string;
}

export async function handleCustomToolsMcpRequest(
  caller: CustomToolsCaller,
  request: {
    method?: string;
    params?: { name?: string; arguments?: Record<string, unknown> };
  },
): Promise<{ result?: unknown; error?: { code: string; message: string } }> {
  switch (request.method) {
    case 'initialize':
      return {
        result: {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: CUSTOM_TOOLS_SERVER_NAME, version: '1.0.0' },
        },
      };
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return { result: {} };
    case 'ping':
      return { result: {} };
    case 'tools/list': {
      try {
        const tools = await customToolService.listForMcp();
        return { result: { tools: tools.map(buildToolDefinition) } };
      } catch {
        return { error: { code: 'UNAVAILABLE', message: 'workspace not found' } };
      }
    }
    case 'tools/call': {
      const exposedName = request.params?.name;
      if (!exposedName) {
        return { error: { code: 'INVALID_PARAMS', message: 'tools/call 缺少 params.name' } };
      }

      const tools = await customToolService.listForMcp().catch(() => null);
      if (!tools) {
        return { error: { code: 'UNAVAILABLE', message: 'workspace not found' } };
      }
      const tool = findToolByExposedName(tools, exposedName);
      if (!tool) {
        return { error: { code: 'METHOD_NOT_FOUND', message: `未知工具：${exposedName}` } };
      }

      const params = normalizeParams(request.params?.arguments);
      const missing = tool.args.map((arg) => arg.key).filter((key) => params[key] === undefined);
      if (missing.length > 0) {
        return {
          error: {
            code: 'INVALID_PARAMS',
            message: `缺少参数：${missing.join(', ')}`,
          },
        };
      }

      const workspace = getWorkspaceContext();
      if (!workspace) {
        return { error: { code: 'UNAVAILABLE', message: 'workspace not found' } };
      }
      const renderContext: RenderContext = {
        userId: caller.userId,
        tenantId: workspace.tenantId,
        workspaceId: workspace.id,
        params,
      };

      if (tool.type === 'prompt') {
        try {
          const text = await renderFragments(tool.prompt ?? [], renderContext, (key, ctx) =>
            valutService.resolveManualValueByKey(key, ctx.workspaceId),
          );
          return { result: { content: [{ type: 'text', text }] } };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message.startsWith('valut key not found:') || message.startsWith('missing parameter:')) {
            return { result: errorContent(message) };
          }
          if (message === 'fragment template too large') return { result: errorContent(message) };
          return { result: errorContent('internal error') };
        }
      }

      try {
        const outcome = await execute(tool, params, renderContext);
        return { result: { content: [{ type: 'text', text: JSON.stringify(outcome) }] } };
      } catch (err) {
        return { result: errorContent(toHttpToolError(err)) };
      }
    }
    default:
      return { error: { code: 'METHOD_NOT_FOUND', message: `不支持的方法：${request.method}` } };
  }
}
