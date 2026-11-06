import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { McpServer } from '../models/mcp-server.js';
import { McpSessionEndpoint, type CustomMcpSnapshotEntry } from '../models/mcp-session-endpoint.js';
import { Session } from '../models/session.js';
import { config } from '../config/index.js';
import { getRedisClient } from '../middleware/redis.js';

const SALT_ROUNDS = 10;

export interface McpEndpointInfo {
  token: string;
  serverNames: string[];
}

export type { CustomMcpSnapshotEntry };

/** 节点作用域：工作流节点会话的 token 映射到具体实例节点 */
export interface WorkflowScope {
  instanceId: string;
  nodeId: string;
}

export class McpEndpointService {
  /**
   * 签发会话 MCP 端点（Phase 3 / D2）：
   * - `serverNames` = 个人 MCP 名 ∪ custom 名（去重）——custom 名并入后 Agent 侧
   *   loopback 地址形态与既有完全一致（`acp:start` 协议零变更，F10）；
   * - `customMcpServers` 快照与 `tokenHash` 同一次 `findOneAndUpdate`（沿用 upsert 形态）；
   * - TTL / revoke / workflow 作用域口径零改动。
   */
  async createEndpoint(
    sessionId: string,
    userId: string,
    mcpServerIds: string[],
    workflow?: WorkflowScope,
    customMcpServers: CustomMcpSnapshotEntry[] = [],
  ): Promise<McpEndpointInfo> {
    const servers = await McpServer.find({ _id: { $in: mcpServerIds }, userId, enabled: true });
    if (servers.length !== mcpServerIds.length) {
      throw new Error('SERVER_NOT_FOUND');
    }

    // 签发期 serverNames 去重（同名冲突时 custom 与个人 MCP 共用一个 loopback 地址，
    // 分流按 custom 优先裁决，见 mcp-dispatch D1）
    const serverNames = Array.from(
      new Set([...servers.map((s) => s.name), ...customMcpServers.map((c) => c.name)]),
    );
    const ttl = config.mcpEndpointTokenTtl;
    // 工作流节点会话：token 有效性跟随工作流实例（不设 TTL，由 getStatus 与实例删除兜底撤销）
    const isWorkflow = Boolean(workflow);

    const token = jwt.sign(
      { sessionId, userId, serverNames, ...(workflow ? { workflow } : {}) },
      config.mcpEndpointJwtSecret,
      isWorkflow ? {} : { expiresIn: `${ttl}s` },
    );
    const tokenHash = await bcrypt.hash(token, SALT_ROUNDS);

    await McpSessionEndpoint.findOneAndUpdate(
      { sessionId },
      {
        $set: {
          userId,
          mcpServerIds,
          customMcpServers,
          tokenHash,
          status: 'active',
          workflowInstanceId: workflow?.instanceId ?? null,
          expiresAt: isWorkflow ? null : new Date(Date.now() + ttl * 1000),
        },
      },
      { upsert: true },
    );

    const redis = getRedisClient();
    if (isWorkflow) {
      await redis.set(`mcp:endpoint:${sessionId}`, 'active');
    } else {
      await redis.set(`mcp:endpoint:${sessionId}`, 'active', 'EX', ttl);
    }

    return {
      token,
      serverNames,
    };
  }

  async revokeEndpoint(sessionId: string): Promise<void> {
    await McpSessionEndpoint.findOneAndUpdate(
      { sessionId },
      { $set: { status: 'revoked' } },
    );
    const redis = getRedisClient();
    // The revoked marker only needs to outlive the token itself; without a TTL
    // every closed session would leave a permanent key in Redis.
    await redis.set(`mcp:endpoint:${sessionId}`, 'revoked', 'EX', config.mcpEndpointTokenTtl);
  }

  /**
   * 重签：`mcpServerIds` 与 `customMcpServers` **均空**才返回 null（D2——
   * custom-only 会话必须能重签，否则只勾自定义 MCP 的会话拿不到代理地址）；
   * 两份快照与 workflow 作用域一律沿用存量行。
   */
  async reissueEndpoint(sessionId: string, userId: string): Promise<McpEndpointInfo | null> {
    const endpoint = await McpSessionEndpoint.findOne({ sessionId }).lean();
    const mcpServerIds = (endpoint?.mcpServerIds ?? []) as string[];
    const customMcpServers = ((endpoint?.customMcpServers ?? []) as unknown as CustomMcpSnapshotEntry[]);
    if (!endpoint || (mcpServerIds.length === 0 && customMcpServers.length === 0)) {
      return null;
    }
    // 工作流节点会话重签时保留节点作用域（返工/兜底 resume 场景）
    const session = await Session.findById(sessionId).lean();
    const workflow =
      session?.workflowInstanceId && session?.workflowNodeId
        ? { instanceId: session.workflowInstanceId.toString(), nodeId: session.workflowNodeId }
        : undefined;
    return this.createEndpoint(sessionId, userId, mcpServerIds, workflow, customMcpServers);
  }

  async getStatus(sessionId: string): Promise<string> {
    const redis = getRedisClient();
    const cached = await redis.get(`mcp:endpoint:${sessionId}`);
    if (cached === 'active' || cached === 'revoked') {
      return cached;
    }
    const endpoint = await McpSessionEndpoint.findOne({ sessionId, status: 'active' });
    if (!endpoint) {
      return 'revoked';
    }
    // 工作流节点会话 endpoint：有效性跟随工作流实例，无 TTL 判过期
    if (endpoint.workflowInstanceId) {
      await redis.set(`mcp:endpoint:${sessionId}`, 'active');
      return 'active';
    }
    const remainingMs = endpoint.expiresAt ? endpoint.expiresAt.getTime() - Date.now() : 0;
    if (remainingMs <= 0) {
      return 'revoked';
    }
    // Refill the cache so subsequent requests do not hit Mongo on every call.
    await redis.set(`mcp:endpoint:${sessionId}`, 'active', 'EX', Math.max(Math.floor(remainingMs / 1000), 1));
    return 'active';
  }
}

export const mcpEndpointService = new McpEndpointService();
