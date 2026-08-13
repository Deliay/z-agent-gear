import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { McpServer } from '../models/mcp-server.js';
import { McpSessionEndpoint } from '../models/mcp-session-endpoint.js';
import { Session } from '../models/session.js';
import { config } from '../config/index.js';
import { getRedisClient } from '../middleware/redis.js';

const SALT_ROUNDS = 10;

export interface McpEndpointInfo {
  url: string;
  token: string;
  serverNames: string[];
}

/** 节点作用域：工作流节点会话的 token 映射到具体实例节点 */
export interface WorkflowScope {
  instanceId: string;
  nodeId: string;
}

export class McpEndpointService {
  async createEndpoint(
    sessionId: string,
    userId: string,
    mcpServerIds: string[],
    workflow?: WorkflowScope,
  ): Promise<McpEndpointInfo> {
    const servers = await McpServer.find({ _id: { $in: mcpServerIds }, userId, enabled: true });
    if (servers.length !== mcpServerIds.length) {
      throw new Error('SERVER_NOT_FOUND');
    }

    const serverNames = servers.map(s => s.name);
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
      url: `${config.gatewayUrl}/mcp/${sessionId}`,
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

  async reissueEndpoint(sessionId: string, userId: string): Promise<McpEndpointInfo | null> {
    const endpoint = await McpSessionEndpoint.findOne({ sessionId }).lean();
    if (!endpoint || !endpoint.mcpServerIds || endpoint.mcpServerIds.length === 0) {
      return null;
    }
    // 工作流节点会话重签时保留节点作用域（返工/兜底 resume 场景）
    const session = await Session.findById(sessionId).lean();
    const workflow =
      session?.workflowInstanceId && session?.workflowNodeId
        ? { instanceId: session.workflowInstanceId.toString(), nodeId: session.workflowNodeId }
        : undefined;
    return this.createEndpoint(sessionId, userId, endpoint.mcpServerIds as string[], workflow);
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
