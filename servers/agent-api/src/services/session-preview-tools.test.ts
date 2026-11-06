import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

vi.mock('../models/session-review.js', () => ({
  SessionReview: {},
}));

vi.mock('../models/mcp-server.js', () => ({
  McpServer: {
    findOneAndUpdate: vi.fn(async () => ({ _id: { toString: () => 'preview-tools-id' } })),
    findOne: vi.fn(),
  },
}));

vi.mock('../models/session.js', () => ({
  Session: {
    findOne: vi.fn(),
  },
}));

vi.mock('./session-review-service.js', () => ({
  sessionReviewService: {
    createForMcp: vi.fn(),
    waitForResolution: vi.fn(),
  },
  getMcpReviewTimeoutMs: vi.fn(() => 1_800_000),
}));

vi.mock('./workspace-context.js', () => ({
  actorFilter: vi.fn(() => ({ userId: 'user-1' })),
}));

import {
  handleSessionPreviewToolRequest,
  ensureSessionPreviewToolsServer,
  resolveReviewFiles,
  SESSION_PREVIEW_TOOLS_SERVER_NAME,
  SESSION_PREVIEW_TOOL_DEFINITIONS,
} from './session-preview-tools.js';
import { sessionReviewService } from './session-review-service.js';
import { Session } from '../models/session.js';
import { McpServer } from '../models/mcp-server.js';

const caller = { userId: 'user-1', sessionId: 'sess-1' };

function sessionDoc(root = '/ws/project') {
  return {
    _id: 'sess-1',
    controllerId: 'ctrl-1',
    worktreePath: null,
    cwd: root,
  };
}

describe('session-preview-tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('T-SPT1 initialize / tools/list：唯一工具 review，schema 与提案一致', async () => {
    const init = await handleSessionPreviewToolRequest(caller, { method: 'initialize' });
    expect(init.result).toMatchObject({ serverInfo: { name: SESSION_PREVIEW_TOOLS_SERVER_NAME } });

    const list = await handleSessionPreviewToolRequest(caller, { method: 'tools/list' });
    const tools = (list.result as { tools: typeof SESSION_PREVIEW_TOOL_DEFINITIONS }).tools;
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('review');
    expect(tools[0].inputSchema).toMatchObject({
      type: 'object',
      required: ['files'],
      properties: {
        files: { type: 'array', minItems: 1, maxItems: 50 },
        summary: { type: 'string' },
      },
    });
  });

  it('T-SPT2 review 归属校验：非本会话/非本人拒绝 UNAVAILABLE', async () => {
    vi.mocked(Session.findOne).mockReturnValue({ lean: vi.fn().mockResolvedValue(null) } as never);

    const outcome = await handleSessionPreviewToolRequest(caller, {
      method: 'tools/call',
      params: { name: 'review', arguments: { files: ['a.ts'] } },
    });

    expect(outcome.error).toEqual({ code: 'UNAVAILABLE', message: 'Session not found' });
    expect(sessionReviewService.createForMcp).not.toHaveBeenCalled();
  });

  it('T-SPT3 文件解析：相对→会话根 resolve；越界剔除标注 skipped；去重；>50 拒绝', () => {
    const root = '/ws/project';
    const ok = resolveReviewFiles(root, ['src/a.ts', '../evil.ts', '/etc/passwd', 'src/a.ts', '']);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value.files).toEqual([
        { path: 'src/a.ts', absPath: path.join(root, 'src/a.ts') },
      ]);
      expect(ok.value.skipped).toEqual(['../evil.ts', '/etc/passwd', '']);
    }

    const many = Array.from({ length: 51 }, (_, i) => `f${i}.ts`);
    const tooMany = resolveReviewFiles(root, many);
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.message).toBe('too many files (max 50)');

    expect(resolveReviewFiles(root, []).ok).toBe(false);
  });

  it('T-SPT4 通过/驳回/评论回包：{file_reviews, comment, status: Approve/Reject/Comment}', async () => {
    vi.mocked(Session.findOne).mockReturnValue({ lean: vi.fn().mockResolvedValue(sessionDoc()) } as never);
    vi.mocked(sessionReviewService.createForMcp).mockResolvedValue({ id: 'rev-1', status: 'PENDING' });
    vi.mocked(sessionReviewService.waitForResolution).mockResolvedValue({
      kind: 'resolved',
      review: {
        id: 'rev-1',
        status: 'APPROVED',
        fileReviews: { 'src/a.ts': [{ id: 'c1', body: 'fix' }] },
        comment: 'ok',
      },
    });

    const outcome = await handleSessionPreviewToolRequest(caller, {
      method: 'tools/call',
      params: { name: 'review', arguments: { files: ['src/a.ts'], summary: 'check' } },
    });

    const text = (outcome.result as { content: Array<{ text: string }> }).content[0].text;
    expect(JSON.parse(text)).toEqual({
      file_reviews: { 'src/a.ts': [{ id: 'c1', body: 'fix' }] },
      comment: 'ok',
      status: 'Approve',
    });
    expect(sessionReviewService.createForMcp).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      sessionId: 'sess-1',
      files: [{ path: 'src/a.ts', absPath: '/ws/project/src/a.ts' }],
      summary: 'check',
    }));

    vi.mocked(sessionReviewService.waitForResolution).mockResolvedValue({
      kind: 'resolved',
      review: { id: 'rev-1', status: 'REJECTED', fileReviews: {}, comment: 'no' },
    });
    const rejected = await handleSessionPreviewToolRequest(caller, {
      method: 'tools/call',
      params: { name: 'review', arguments: { files: ['src/a.ts'] } },
    });
    expect(JSON.parse((rejected.result as { content: Array<{ text: string }> }).content[0].text).status).toBe('Reject');
  });

  it('T-SPT5 取消回包：{cancelled:true, reason:timeout/session_closed}（isError=false）', async () => {
    vi.mocked(Session.findOne).mockReturnValue({ lean: vi.fn().mockResolvedValue(sessionDoc()) } as never);
    vi.mocked(sessionReviewService.createForMcp).mockResolvedValue({ id: 'rev-1', status: 'PENDING' });
    vi.mocked(sessionReviewService.waitForResolution).mockResolvedValue({
      kind: 'cancelled',
      reason: 'timeout',
    });

    const outcome = await handleSessionPreviewToolRequest(caller, {
      method: 'tools/call',
      params: { name: 'review', arguments: { files: ['src/a.ts'] } },
    });

    expect(outcome.error).toBeUndefined();
    const text = (outcome.result as { content: Array<{ text: string }> }).content[0].text;
    expect(JSON.parse(text)).toEqual({ cancelled: true, reason: 'timeout' });
  });

  it('T-SPT6 装配：ensureSessionPreviewToolsServer 幂等 upsert（platform transport、唯一工具 review）', async () => {
    const id = await ensureSessionPreviewToolsServer('user-1');
    expect(id).toBe('preview-tools-id');
    expect(McpServer.findOneAndUpdate).toHaveBeenCalledWith(
      { userId: 'user-1', name: SESSION_PREVIEW_TOOLS_SERVER_NAME },
      {
        $setOnInsert: expect.objectContaining({
          transport: 'platform',
          source: 'platform',
          enabled: true,
          tools: [{ name: 'review', description: expect.any(String) }],
        }),
      },
      { upsert: true, returnDocument: 'after' },
    );
  });

  it('未知工具 / 未知方法报 METHOD_NOT_FOUND', async () => {
    const unknownTool = await handleSessionPreviewToolRequest(caller, {
      method: 'tools/call',
      params: { name: 'nope', arguments: {} },
    });
    expect(unknownTool.error?.code).toBe('METHOD_NOT_FOUND');

    const unknownMethod = await handleSessionPreviewToolRequest(caller, { method: 'bogus' });
    expect(unknownMethod.error?.code).toBe('METHOD_NOT_FOUND');
  });
});
