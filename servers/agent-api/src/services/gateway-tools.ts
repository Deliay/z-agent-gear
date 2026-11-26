import { McpServer } from '../models/mcp-server.js';
import { Session } from '../models/session.js';
import { config } from '../config/index.js';
import { gatewayService } from './gateway.js';
import { buildGatewayBasePath } from './gateway-endpoint.js';
import { GATEWAY_PROMPT_RESOURCES, getGatewayPromptResource } from './gateway-prompts.js';

/**
 * 平台内置 MCP `agent-gateway-tools`（需求 #565 / 提案 §3.1）。
 *
 * - 三工具：`gateway_list` / `gateway_create_endpoint` / `gateway_delete_endpoint`；
 * - 操作对象 = **会话所在控制器**（`caller.sessionId → Session.controllerId`），不接受外部 controllerId；
 * - `initialize` 声明 `capabilities: { tools: {}, resources: {} }`（不声明 prompts，遵守 #580 裁决）；
 * - 暴露指引经 `resources/list` / `resources/read` 投递
 *   （`zag://agent-gateway-tools/prompt/gateway-exposure-guidance`）；
 * - `tools/call` 错误统一 `content[0].text = JSON.stringify({code,message}) + isError:true`；
 * - 未知方法 / 未知工具 → JSON-RPC `METHOD_NOT_FOUND`。
 */

export const GATEWAY_TOOLS_SERVER_NAME = 'agent-gateway-tools';

/** 工具 description 统一附加的发现引导（与 resources URI 同源） */
export const GATEWAY_DISCOVERY_HINT =
  '创建端点后请阅读资源 `zag://agent-gateway-tools/prompt/gateway-exposure-guidance`，' +
  '以返回的 endpoint 作为外网 basePath 配置服务（如 Vite `base`）';

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const NAME_RULE = '[a-zA-Z0-9_-]{1,50}';

export const GATEWAY_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'gateway_list',
    description:
      '列出当前会话控制器上的网关端点（含 endpoint/basePath）；仅在用户要求暴露服务时使用。' +
      GATEWAY_DISCOVERY_HINT,
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'gateway_create_endpoint',
    description:
      `创建网关端点并返回可直接使用的 endpoint 与 basePath；名称规则 ${NAME_RULE}（控制器内唯一），` +
      `端口为 1~65535 的整数；仅在用户要求暴露服务时使用。${GATEWAY_DISCOVERY_HINT}`,
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: `端点名称（${NAME_RULE}，控制器内唯一）`,
        },
        port: {
          type: 'integer',
          description: '本地服务端口（1~65535）',
          minimum: 1,
          maximum: 65535,
        },
      },
      required: ['name', 'port'],
    },
  },
  {
    name: 'gateway_delete_endpoint',
    description:
      '删除当前会话控制器上的网关端点（不存在或非本人端点统一返回未找到，不泄露存在性）；' +
      '仅在用户要求撤销暴露时使用。' +
      GATEWAY_DISCOVERY_HINT,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: `端点名称（${NAME_RULE}）` },
      },
      required: ['name'],
    },
  },
];

/** 幂等 upsert 平台网关工具服务，返回其 _id（对齐 ensureKnowledgeBaseToolsServer 形态）。 */
export async function ensureGatewayToolsServer(userId: string): Promise<string> {
  try {
    const server = await McpServer.findOneAndUpdate(
      { userId, name: GATEWAY_TOOLS_SERVER_NAME },
      {
        $setOnInsert: {
          userId,
          name: GATEWAY_TOOLS_SERVER_NAME,
          transport: 'platform',
          source: 'platform',
          enabled: true,
          tools: GATEWAY_TOOL_DEFINITIONS.map((tool) => ({
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
        name: GATEWAY_TOOLS_SERVER_NAME,
      }).lean();
      if (existing) return existing._id.toString();
    }
    throw err;
  }
}

export interface GatewayToolCaller {
  userId: string;
  sessionId: string;
}

export type GatewayToolResult =
  | { result?: unknown; error?: { code: string; message: string } };

/** 会话所在控制器（不接受外部 controllerId，提案 D8 / 计划 D2）。 */
async function resolveSessionControllerId(sessionId: string): Promise<string | null> {
  if (!sessionId) return null;
  const session = await Session.findById(sessionId).select('controllerId').lean();
  if (!session || !session.controllerId) return null;
  return String(session.controllerId);
}

function ok(payload: unknown): GatewayToolResult {
  return { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } };
}

/** 统一工具错误形态：`{code,message}` JSON 文本 + `isError:true`。 */
function toolError(code: string, message: string): GatewayToolResult {
  return {
    result: {
      content: [{ type: 'text', text: JSON.stringify({ code, message }) }],
      isError: true,
    },
  };
}

function invalidParams(message: string): GatewayToolResult {
  return toolError('INVALID_PARAMS', message);
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/** 白名单错误逐字透传；未命中收敛 internal error。 */
const GATEWAY_ERRORS = new Set([
  'Controller not found',
  'Controller is not online',
  'Name can only contain letters, numbers, hyphens, and underscores',
  'Name length must be 1-50 characters',
  'Gateway name already exists',
  'Gateway not found or not active',
]);

function toToolFailure(err: unknown): GatewayToolResult {
  const message = err instanceof Error ? err.message : String(err);
  const isMax = /^Maximum \d+ gateways per controller$/.test(message);
  if (GATEWAY_ERRORS.has(message) || isMax) {
    return toolError('GATEWAY_ERROR', message);
  }
  return toolError('INTERNAL_ERROR', 'internal error');
}

function gatewaySummary(
  controllerId: string,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const name = String(row.name);
  return {
    name,
    port: row.port,
    status: row.status,
    endpoint: row.endpoint,
    basePath: buildGatewayBasePath(controllerId, name),
  };
}

/** 平台 MCP `agent-gateway-tools` 本地分发。 */
export async function handleGatewayToolsMcpRequest(
  caller: GatewayToolCaller,
  request: {
    method?: string;
    params?: { name?: string; uri?: string; arguments?: Record<string, unknown> };
  },
): Promise<GatewayToolResult> {
  switch (request.method) {
    case 'initialize':
      return {
        result: {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: GATEWAY_TOOLS_SERVER_NAME, version: '1.0.0' },
        },
      };
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return { result: {} };
    case 'ping':
      return { result: {} };
    case 'resources/list':
      return { result: { resources: GATEWAY_PROMPT_RESOURCES } };
    case 'resources/read': {
      const available = GATEWAY_PROMPT_RESOURCES.map((item) => item.uri).join('、');
      const uri = request.params?.uri;
      if (typeof uri !== 'string' || uri.trim().length === 0) {
        return {
          error: {
            code: 'INVALID_PARAMS',
            message: `resources/read 缺少 params.uri。可用资源：${available}。`,
          },
        };
      }
      const found = getGatewayPromptResource(uri);
      if (!found) {
        return {
          error: {
            code: 'INVALID_PARAMS',
            message: `未知资源「${uri}」。可用资源：${available}。`,
          },
        };
      }
      return {
        result: {
          contents: [
            {
              uri: found.definition.uri,
              mimeType: found.definition.mimeType,
              text: found.text,
            },
          ],
        },
      };
    }
    case 'tools/list':
      return { result: { tools: GATEWAY_TOOL_DEFINITIONS } };
    case 'tools/call': {
      const toolName = request.params?.name;
      if (!toolName) {
        return { error: { code: 'INVALID_PARAMS', message: 'tools/call 缺少 params.name' } };
      }
      const args = request.params?.arguments ?? {};
      if (
        toolName !== 'gateway_list' &&
        toolName !== 'gateway_create_endpoint' &&
        toolName !== 'gateway_delete_endpoint'
      ) {
        return { error: { code: 'METHOD_NOT_FOUND', message: `未知工具：${toolName}` } };
      }
      try {
        const controllerId = await resolveSessionControllerId(caller.sessionId);
        if (!controllerId) {
          return toolError('NOT_FOUND', 'Controller not found');
        }
        switch (toolName) {
          case 'gateway_list': {
            const result = await gatewayService.findAllByController(
              controllerId,
              caller.userId,
            );
            return ok({
              gateways: result.gateways.map((row) => gatewaySummary(controllerId, row)),
              limit: config.gatewayMaxPerController,
            });
          }
          case 'gateway_create_endpoint': {
            const name = args.name;
            if (typeof name !== 'string' || name.length === 0) {
              return invalidParams(
                `缺少或非法参数 name：必须为 ${NAME_RULE} 的字符串（控制器内唯一）`,
              );
            }
            const port = args.port;
            if (!isInteger(port) || port < 1 || port > 65535) {
              return invalidParams('缺少或非法参数 port：必须为 1~65535 的整数');
            }
            const created = await gatewayService.create(
              controllerId,
              caller.userId,
              name,
              port,
              config.gatewayMaxPerController,
            );
            return ok(gatewaySummary(controllerId, created));
          }
          case 'gateway_delete_endpoint': {
            const name = args.name;
            if (typeof name !== 'string' || name.length === 0) {
              return invalidParams(`缺少或非法参数 name：必须为 ${NAME_RULE} 的字符串`);
            }
            const deleted = await gatewayService.delete(controllerId, caller.userId, name);
            if (!deleted) {
              return toolError('NOT_FOUND', 'Gateway not found or not active');
            }
            return ok({ deleted: true });
          }
        }
      } catch (err) {
        return toToolFailure(err);
      }
      // 不可达（switch 已覆盖全部已知工具）
      return { error: { code: 'METHOD_NOT_FOUND', message: `未知工具：${toolName}` } };
    }
    default:
      return { error: { code: 'METHOD_NOT_FOUND', message: `不支持的方法：${request.method}` } };
  }
}
