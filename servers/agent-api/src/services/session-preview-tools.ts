import mongoose from 'mongoose';
import path from 'path';
import { McpServer } from '../models/mcp-server.js';
import { Session } from '../models/session.js';
import { actorFilter } from './workspace-context.js';
import {
  sessionReviewService,
  getMcpReviewTimeoutMs,
  type SessionReviewFileInput,
} from './session-review-service.js';
import { logger } from '../observability/logger.js';

const log = logger.child({ component: 'session-preview-tools' });

/** 平台内建会话预览工具服务（全会话默认装配；Review 工具同步等待用户结论） */
export const SESSION_PREVIEW_TOOLS_SERVER_NAME = 'agent-session-preview-tools';

export const SESSION_REVIEW_MAX_FILES = 50;

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const SESSION_PREVIEW_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'review',
    description:
      '请求用户评审一个或多个文件：创建评审界面，等待用户逐文件批注并给出通过/驳回/仅评论的总体结论后返回结构化结果',
    inputSchema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: SESSION_REVIEW_MAX_FILES,
          description: '相对会话工作目录的文件路径（或工作区内绝对路径）',
        },
        summary: { type: 'string', description: '评审背景说明（展示给用户）' },
      },
      required: ['files'],
    },
  },
];

/** 幂等 upsert 会话预览平台工具服务，返回其 _id（对齐 ensureCloudHostToolsServer 形态） */
export async function ensureSessionPreviewToolsServer(userId: string): Promise<string> {
  try {
    const server = await McpServer.findOneAndUpdate(
      { userId, name: SESSION_PREVIEW_TOOLS_SERVER_NAME },
      {
        $setOnInsert: {
          userId,
          name: SESSION_PREVIEW_TOOLS_SERVER_NAME,
          transport: 'platform',
          source: 'platform',
          enabled: true,
          tools: SESSION_PREVIEW_TOOL_DEFINITIONS.map((tool) => ({
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
      const existing = await McpServer.findOne({ userId, name: SESSION_PREVIEW_TOOLS_SERVER_NAME }).lean();
      if (existing) return existing._id.toString();
    }
    throw err;
  }
}

export interface SessionPreviewToolCaller {
  userId: string;
  sessionId: string;
}

interface ResolvedReviewFiles {
  files: SessionReviewFileInput[];
  skipped: string[];
}

/**
 * 文件解析（裁决 12 / T-SPT3）：相对路径基于 `session.worktreePath ?? session.cwd` resolve；
 * normalize 后必须以会话根为前缀，否则越界剔除并标注 skipped；去重；>50 拒绝。
 */
export function resolveReviewFiles(
  sessionRoot: string,
  rawFiles: unknown,
): { ok: true; value: ResolvedReviewFiles } | { ok: false; message: string } {
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
    return { ok: false, message: 'files 必填（1~50 个路径）' };
  }
  const root = path.resolve(sessionRoot);
  const files: SessionReviewFileInput[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawFiles) {
    if (typeof raw !== 'string' || raw.trim() === '') {
      skipped.push(String(raw));
      continue;
    }
    const absPath = path.resolve(root, raw);
    const rel = path.relative(root, absPath);
    const outside = rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
    if (outside) {
      skipped.push(raw);
      continue;
    }
    const display = rel.split(path.sep).join('/');
    if (seen.has(display)) continue;
    seen.add(display);
    files.push({ path: display, absPath });
  }
  if (files.length > SESSION_REVIEW_MAX_FILES) {
    return { ok: false, message: `too many files (max ${SESSION_REVIEW_MAX_FILES})` };
  }
  return { ok: true, value: { files, skipped } };
}

/**
 * 平台 MCP 工具处理：`review`。
 * 归属校验（actorFilter）→ 文件解析 → createForMcp → waitForResolution（30min 超时自动取消）
 * → 按终态组装结构化结果 / 取消 JSON。
 */
export async function handleSessionPreviewToolRequest(
  caller: SessionPreviewToolCaller,
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
          serverInfo: { name: SESSION_PREVIEW_TOOLS_SERVER_NAME, version: '1.0.0' },
        },
      };
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return { result: {} };
    case 'ping':
      return { result: {} };
    case 'tools/list':
      return { result: { tools: SESSION_PREVIEW_TOOL_DEFINITIONS } };
    case 'tools/call': {
      const toolName = request.params?.name;
      if (!toolName) {
        return { error: { code: 'INVALID_PARAMS', message: 'tools/call 缺少 params.name' } };
      }
      if (toolName !== 'review') {
        return { error: { code: 'METHOD_NOT_FOUND', message: `未知工具：${toolName}` } };
      }
      try {
        // 归属校验：非本会话/非本人拒绝（T-SPT2）
        const session = await Session.findOne({
          _id: caller.sessionId,
          ...actorFilter(caller.userId),
        }).lean();
        if (!session) {
          return { error: { code: 'UNAVAILABLE', message: 'Session not found' } };
        }
        const sessionRoot = String(session.worktreePath ?? session.cwd ?? '');
        if (!sessionRoot) {
          return { error: { code: 'UNAVAILABLE', message: 'session has no workspace root' } };
        }
        const args = request.params?.arguments ?? {};
        const resolved = resolveReviewFiles(sessionRoot, args.files);
        if (!resolved.ok) {
          return { error: { code: 'INVALID_PARAMS', message: resolved.message } };
        }
        const summary = typeof args.summary === 'string' ? args.summary : undefined;
        const review = await sessionReviewService.createForMcp({
          userId: caller.userId,
          sessionId: caller.sessionId,
          controllerId: String(session.controllerId),
          files: resolved.value.files,
          summary,
        });
        const outcome = await sessionReviewService.waitForResolution(
          String(review.id),
          getMcpReviewTimeoutMs(),
        );
        if (outcome.kind === 'cancelled') {
          // 取消（超时/会话结束）回包 isError=false，便于 Agent 继续
          return {
            result: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ cancelled: true, reason: outcome.reason }),
                },
              ],
            },
          };
        }
        const finalReview = outcome.review;
        const statusText =
          finalReview.status === 'APPROVED' ? 'Approve' : finalReview.status === 'REJECTED' ? 'Reject' : 'Comment';
        return {
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  file_reviews: finalReview.fileReviews ?? {},
                  comment: finalReview.comment ?? '',
                  status: statusText,
                  ...(resolved.value.skipped.length > 0 ? { skipped: resolved.value.skipped } : {}),
                }),
              },
            ],
          },
        };
      } catch (err) {
        log.warn({ err, sessionId: caller.sessionId }, 'review tool call failed');
        return {
          error: { code: 'INTERNAL_ERROR', message: (err as Error).message || 'internal error' },
        };
      }
    }
    default:
      return { error: { code: 'METHOD_NOT_FOUND', message: `不支持的方法：${request.method}` } };
  }
}
