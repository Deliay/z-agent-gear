import { McpServer } from '../models/mcp-server.js';
import { valutService } from './valut-service.js';

/**
 * 平台内置 MCP `agent-valut-tools`（需求 #449 / 提案 §5.2 实现点 2）。
 *
 * **名单工具，不提供取值工具**（安全红线）：
 * - 唯一工具 `valut_list`：返回当前会话工作区 **manual** namespace 的密钥名称；
 * - 出参仅 `[{key, namespaceDisplayName}]`——不透出 id / 明文 / refs；
 * - 其他工具名（含任何取值诉求）一律 `METHOD_NOT_FOUND`。
 *
 * 形态对齐 `session-preview-tools.ts`：`ensure*Server` 幂等 upsert + switch handler，
 * 由 `mcp-dispatch` 在 `runWithWorkspace(会话工作区)` 内直发；`listManualOptions`
 * 服务层强制 `workspaceId=当前工作区`（无 ALS 上下文返回空集，不误拒绝）。
 */

export const VALUT_TOOLS_SERVER_NAME = 'agent-valut-tools';

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const VALUT_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'valut_list',
    description:
      '列出当前工作区可用（手动创建）的 Valut 密钥名称；不提供任何获取密钥值的工具',
    inputSchema: { type: 'object', properties: {} },
  },
];

/** 幂等 upsert 平台 Valut 工具服务，返回其 _id（对齐 ensureSessionPreviewToolsServer 形态）。 */
export async function ensureValutToolsServer(userId: string): Promise<string> {
  try {
    const server = await McpServer.findOneAndUpdate(
      { userId, name: VALUT_TOOLS_SERVER_NAME },
      {
        $setOnInsert: {
          userId,
          name: VALUT_TOOLS_SERVER_NAME,
          transport: 'platform',
          source: 'platform',
          enabled: true,
          tools: VALUT_TOOL_DEFINITIONS.map((tool) => ({
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
      const existing = await McpServer.findOne({ userId, name: VALUT_TOOLS_SERVER_NAME }).lean();
      if (existing) return existing._id.toString();
    }
    throw err;
  }
}

export interface ValutToolCaller {
  userId: string;
  sessionId: string;
}

/** 平台 MCP `agent-valut-tools` 本地分发（仅名单；无取值工具）。 */
export async function handleValutToolsMcpRequest(
  _caller: ValutToolCaller,
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
          serverInfo: { name: VALUT_TOOLS_SERVER_NAME, version: '1.0.0' },
        },
      };
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return { result: {} };
    case 'ping':
      return { result: {} };
    case 'tools/list':
      return { result: { tools: VALUT_TOOL_DEFINITIONS } };
    case 'tools/call': {
      const toolName = request.params?.name;
      if (!toolName) {
        return { error: { code: 'INVALID_PARAMS', message: 'tools/call 缺少 params.name' } };
      }
      if (toolName !== 'valut_list') {
        // 不存在取值工具：任何其他工具名（含 valut_get / valut_value）一律拒绝
        return { error: { code: 'METHOD_NOT_FOUND', message: `未知工具：${toolName}` } };
      }
      const entries = await valutService.listManualOptions();
      const names = entries.map((entry) => ({
        key: entry.key,
        namespaceDisplayName: entry.namespaceDisplayName,
      }));
      return {
        result: {
          content: [{ type: 'text', text: JSON.stringify(names) }],
        },
      };
    }
    default:
      return { error: { code: 'METHOD_NOT_FOUND', message: `不支持的方法：${request.method}` } };
  }
}
