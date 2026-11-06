import mongoose from 'mongoose';
import { CustomMcpServer } from '../models/custom-mcp-server.js';
import type { CustomMcpSnapshotEntry } from '../models/mcp-session-endpoint.js';
import { valutService } from './valut-service.js';
import { runWithWorkspace } from './workspace-context.js';
import { logger as rootLogger } from '../observability/logger.js';

/**
 * 自定义 MCP 服务端转发器（MCP+Valut 功能迭代 Phase 3，提案 §5.2 实现点 6 / D6 / D7 / D8）。
 *
 * 会话只拿到既有 loopback 代理地址（`/mcp/<sessionId>/<name>`）+ 会话级密钥；真实
 * endpoint、customHeaders 与 bearer token **不出服务端**。
 *
 * - **实时存在性**：按快照 id 每次请求 `CustomMcpServer.findById`（D9 删除即全端点失效）——
 *   不存在 → `410`；无需逐会话回收 key。
 * - **配置实时加载**：路由用快照 name（改名不影响存量会话），endpoint/headers/token 按 id
 *   实时读取（编辑后新调用立即生效，PRD 功能点 8）。
 * - **请求组装**：customHeaders 同名多值展开（`Headers.append`）；`authType=bearer` 时
 *   `Authorization: Bearer <resolveValue(...)>`（解密仅内存，D8，托管凭据覆盖同名自定义头）。
 * - **失败语义**：真实 endpoint 不可达 / 30s 超时 → `502`；条目加载失败按 `410` 同口径
 *   防御式（MCP 与自建条目同生灭，正常路径不可达，D8）。
 * - **日志**：响应正文/错误正文/请求头一律不入日志（`mcp-relay-consumer`「响应正文不入日志」
 *   同口径）；错误信息对 endpoint 与 token **先替换再截断**后落日志。
 * - **通知形态**（JSON-RPC body 无 id）由 `mcp-dispatch` fire-and-forget（D7），本模块只管转发。
 */

const logger = rootLogger.child({ component: 'custom-mcp-forwarder' });

/** 真实 endpoint 单次转发超时（与 relay 60s 请求超时构成双层兜底）。 */
export const CUSTOM_MCP_FORWARD_TIMEOUT_MS = 30_000;

export interface CustomMcpForwardParams {
  sessionId: string;
  /** 会话端点 `customMcpServers` 快照条目：id 实时加载配置、name 仅路由诊断/日志 */
  snapshotEntry: CustomMcpSnapshotEntry;
  /** JSON-RPC 请求体（原样转发，不改写） */
  body: unknown;
}

export interface CustomMcpForwardResult {
  status: number;
  body: unknown;
}

interface LoadedCustomMcp {
  endpoint: string;
  authType: string;
  customHeaders: unknown;
  bearerValutEntryId: string | null;
}

function jsonRpcError(id: unknown, code: string, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function toArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter((item) => item.length > 0);
  if (typeof value === 'string' && value.length > 0) return [value];
  return [];
}

/** customHeaders 归一（Mongoose Map 与 plain object 两种形态）。 */
function headerEntries(raw: unknown): Array<[string, string[]]> {
  if (raw instanceof Map) {
    return [...raw.entries()].map(([key, values]) => [String(key), toArray(values)]);
  }
  if (raw && typeof raw === 'object') {
    return Object.entries(raw as Record<string, unknown>).map(([key, values]) => [
      String(key),
      toArray(values),
    ]);
  }
  return [];
}

/**
 * 错误信息落日志前替换敏感片段（endpoint / token），并截断长度。
 *
 * **顺序不可颠倒（返工 MINOR-5）**：先全量替换敏感片段、再截断——若先截断，
 * secret 跨 300 边界时前半段明文会落日志；替换后的结果再截断最多丢 `[redacted]`
 * 尾巴，不会复现明文。
 */
function sanitizeMessage(message: string, secrets: Array<string | null | undefined>): string {
  let out = message;
  for (const secret of secrets) {
    if (secret && secret.length > 0) out = out.split(secret).join('[redacted]');
  }
  return out.length > 300 ? `${out.slice(0, 300)}…` : out;
}

export class CustomMcpForwarder {
  constructor(private readonly timeoutMs: number = CUSTOM_MCP_FORWARD_TIMEOUT_MS) {}

  async forward(params: CustomMcpForwardParams): Promise<CustomMcpForwardResult> {
    const { sessionId, snapshotEntry, body } = params;
    const mcpId = String(snapshotEntry.id);
    const name = snapshotEntry.name;
    const requestId = (body as { id?: unknown } | null)?.id ?? null;
    let endpoint: string | null = null;
    let token: string | null = null;

    try {
      const server = await this.loadServer(mcpId);
      if (!server) return this.gone(sessionId, mcpId, name, requestId, 'server-not-found');
      endpoint = server.endpoint;

      const headers = new Headers();
      for (const [key, values] of headerEntries(server.customHeaders)) {
        for (const value of values) headers.append(key, value);
      }
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');

      if (server.authType === 'bearer') {
        if (!server.bearerValutEntryId) {
          return this.gone(sessionId, mcpId, name, requestId, 'bearer-entry-missing');
        }
        try {
          // 解密仅内存（D8）：resolveValue 的唯一消费点，明文只进请求头不进任何日志字段
          token = await runWithWorkspace(undefined, () =>
            valutService.resolveValue(server.bearerValutEntryId as string),
          );
        } catch {
          // 自建条目被级联删除 / 条目不可读：按 410 同口径防御式（D8）
          return this.gone(sessionId, mcpId, name, requestId, 'bearer-entry-unreadable');
        }
        // 托管凭据优先：覆盖 customHeaders 中的同名 authorization
        headers.set('authorization', `Bearer ${token}`);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      timer.unref?.();
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body ?? null),
          signal: controller.signal,
        });
        const text = await response.text();
        let parsed: unknown;
        if (text.length === 0) {
          parsed = null;
        } else {
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = text;
          }
        }
        // 响应正文不入日志（第三方 MCP 响应可含凭据）
        logger.debug(
          { event: 'custom-mcp-forward-result', sessionId, mcpId, name, status: response.status },
          'custom MCP forward result',
        );
        return { status: response.status, body: parsed };
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      logger.warn(
        {
          event: 'custom-mcp-forward-failed',
          sessionId,
          mcpId,
          name,
          errName: err instanceof Error ? err.name : 'unknown',
          errMessage: sanitizeMessage(errMessage, [endpoint, token]),
        },
        'custom MCP forward failed',
      );
      return {
        status: 502,
        body: jsonRpcError(requestId, 'FORWARD_ERROR', 'Custom MCP forward failed'),
      };
    }
  }

  /**
   * 按快照 id 实时加载配置（D9 删除即 410）。
   *
   * 服务端内部读：显式把 ALS 工作区上下文置为 `undefined`，绕过 `applyWorkspaceScope`
   * 的读过滤注入——转发链路（relay 消费）本无工作区上下文，此处置空是防御式显式条件，
   * 保证「按 id 实时校验」不受任何请求级工作区上下文影响。
   */
  private async loadServer(id: string): Promise<LoadedCustomMcp | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    const doc = await runWithWorkspace(undefined, () => CustomMcpServer.findById(id));
    if (!doc) return null;
    return {
      endpoint: String(doc.endpoint),
      authType: String(doc.authType),
      customHeaders: doc.customHeaders,
      bearerValutEntryId: doc.bearerValutEntryId ? String(doc.bearerValutEntryId) : null,
    };
  }

  /** 自定义 MCP 已删除/条目失效：全端点统一 410（无需逐会话回收 key）。 */
  private gone(
    sessionId: string,
    mcpId: string,
    name: string,
    requestId: unknown,
    reason: string,
  ): CustomMcpForwardResult {
    logger.warn(
      { event: 'custom-mcp-gone', sessionId, mcpId, name, reason },
      'custom MCP server gone',
    );
    return {
      status: 410,
      body: jsonRpcError(requestId, 'SERVER_NOT_FOUND', 'Custom MCP server has been deleted'),
    };
  }
}

export const customMcpForwarder = new CustomMcpForwarder();
