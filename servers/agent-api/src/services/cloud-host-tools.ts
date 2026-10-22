import mongoose from 'mongoose';
import { CloudHost } from '../models/cloud-host.js';
import { Controller } from '../models/controller.js';
import { McpServer } from '../models/mcp-server.js';
import { Session } from '../models/session.js';
import {
  cloudHostWorkloadService,
  type CloudHostWorkloadService,
} from './cloud-host-workload-service.js';

export const CLOUD_HOST_TOOLS_SERVER_NAME = 'agent-cloud-host-tools';

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const CLOUD_HOST_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'workload_list',
    description: '列出当前云主机可安装的工作负载（含已安装标记与参数定义）',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'workload_install',
    description: '在当前云主机安装工作负载，等待完成并返回结果',
    inputSchema: {
      type: 'object',
      properties: {
        workloadId: { type: 'string' },
        params: { type: 'object' },
      },
      required: ['workloadId'],
    },
  },
];

/** 幂等 upsert 云主机平台工具服务，返回其 _id。 */
export async function ensureCloudHostToolsServer(userId: string): Promise<string> {
  try {
    const server = await McpServer.findOneAndUpdate(
      { userId, name: CLOUD_HOST_TOOLS_SERVER_NAME },
      {
        $setOnInsert: {
          userId,
          name: CLOUD_HOST_TOOLS_SERVER_NAME,
          transport: 'platform',
          source: 'platform',
          enabled: true,
          tools: CLOUD_HOST_TOOL_DEFINITIONS.map((tool) => ({
            name: tool.name,
            description: tool.description,
          })),
        },
      },
      { upsert: true, new: true },
    );
    return server._id.toString();
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code: number }).code === 11000) {
      const existing = await McpServer.findOne({ userId, name: CLOUD_HOST_TOOLS_SERVER_NAME }).lean();
      if (existing) return existing._id.toString();
    }
    throw err;
  }
}

async function resolveCloudHost(sessionId: string, userId: string): Promise<Record<string, unknown> | null> {
  if (!mongoose.isValidObjectId(sessionId)) return null;
  const session = await Session.findOne({ _id: sessionId, userId }).lean();
  if (!session) return null;
  const controller = await Controller.findOne({
    _id: session.controllerId,
    userId,
  }).lean();
  if (!controller || controller.type !== 'cloud') return null;
  const host = await CloudHost.findOne({
    controllerId: controller._id,
    userId,
    deletedAt: null,
  }).lean();
  return host ? (host as unknown as Record<string, unknown>) : null;
}

export interface CloudHostToolCaller {
  userId: string;
  sessionId: string;
}

/**
 * 云主机平台 MCP 工具处理：`workload_list` / `workload_install`。
 * 仅云主机会话可用；安装会等待 operation 完成（上限 10 分钟）。
 */
export async function handleCloudHostToolRequest(
  caller: CloudHostToolCaller,
  request: {
    method?: string;
    params?: { name?: string; arguments?: Record<string, unknown> };
  },
  service: CloudHostWorkloadService = cloudHostWorkloadService,
): Promise<{ result?: unknown; error?: { code: string; message: string } }> {
  switch (request.method) {
    case 'initialize':
      return {
        result: {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: CLOUD_HOST_TOOLS_SERVER_NAME, version: '1.0.0' },
        },
      };
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return { result: {} };
    case 'ping':
      return { result: {} };
    case 'tools/list':
      return { result: { tools: CLOUD_HOST_TOOL_DEFINITIONS } };
    case 'tools/call': {
      const toolName = request.params?.name;
      if (!toolName) {
        return { error: { code: 'INVALID_PARAMS', message: 'tools/call 缺少 params.name' } };
      }
      try {
        const host = await resolveCloudHost(caller.sessionId, caller.userId);
        if (!host) {
          return {
            error: {
              code: 'UNAVAILABLE',
              message: '当前会话不在云主机上',
            },
          };
        }
        const controllerId = String(host.controllerId);
        if (toolName === 'workload_list') {
          const items = await service.list(caller.userId, controllerId);
          return { result: { content: [{ type: 'text', text: JSON.stringify(items) }] } };
        }
        if (toolName === 'workload_install') {
          const args = request.params?.arguments ?? {};
          const workloadId = typeof args.workloadId === 'string' ? args.workloadId : '';
          if (!workloadId) {
            return { error: { code: 'INVALID_PARAMS', message: 'workloadId 必填' } };
          }
          const params =
            args.params && typeof args.params === 'object' && !Array.isArray(args.params)
              ? (args.params as Record<string, unknown>)
              : undefined;
          const operation = await service.createInstallOperation({
            userId: caller.userId,
            controllerId,
            workloadId,
            params,
          });
          const final = await service.waitForCompletion(String(operation.id), 600_000);
          return {
            result: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(final ?? { status: 'RUNNING' }),
                },
              ],
            },
          };
        }
        return { error: { code: 'METHOD_NOT_FOUND', message: `未知工具：${toolName}` } };
      } catch (err) {
        return {
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  code: 'INTERNAL_ERROR',
                  message: err instanceof Error ? err.message : String(err),
                }),
              },
            ],
            isError: true,
          },
        };
      }
    }
    default:
      return { error: { code: 'METHOD_NOT_FOUND', message: `不支持的方法：${request.method}` } };
  }
}
