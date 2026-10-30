import { Router, type Request, type Response } from 'express';
import { User } from '../models/user.js';
import { Session } from '../models/session.js';
import { verifyToken } from '../services/auth.js';
import {
  resolveWorkspaceContext,
  type AuthenticatedUser,
} from '../middleware/auth.js';
import { runWithWorkspace, type WorkspaceContext } from '../services/workspace-context.js';
import { sessionSSEService } from '../services/session-sse.js';

const router = Router();

async function authenticateExpressUser(req: Request): Promise<AuthenticatedUser | null> {
  // Support both Authorization header and ?token= query param (for EventSource which cannot set headers)
  let token: string | undefined;
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    token = header.slice(7);
  } else if (req.query.token && typeof req.query.token === 'string') {
    token = req.query.token;
  }

  if (!token) {
    return null;
  }

  try {
    const payload = verifyToken(token);
    const user = await User.findById(payload.userId).select('name tenantId');
    if (!user) {
      return null;
    }
    const id = user._id.toString();
    return {
      id,
      // 半迁移兜底与 `authenticateUser` 同口径：缺失 tenantId 时个人租户恒等 userId
      tenantId: user.tenantId ? user.tenantId.toString() : id,
      name: user.name ?? '',
    };
  } catch {
    return null;
  }
}

/**
 * 会话所属工作区上下文（多租户二期）。
 *
 * SSE 由 EventSource 发起，**无法携带 `x-workspace-id` 请求头**，因此不能复用 GraphQL 的
 * 请求头解析；改为按会话归属反查工作区，再走与 GraphQL 完全一致的可访问性校验：
 * - 会话存在且归属工作区可访问 → 返回上下文（查询在 `runWithWorkspace` 内执行，插件按
 *   `workspaceId ∈ [当前, 租户全局]` 过滤，团队租户不会再退化成 `tenantId = userId`）；
 * - 会话不存在 / 工作区不可访问 / id 非法 → `null`（统一按 Session not found 处理，不泄露存在性）；
 * - 历史一期会话无 `workspaceId` → `undefined`（保持 `{userId}` 归属口径，行为不变）。
 */
async function resolveSessionWorkspace(
  sessionId: string,
  user: AuthenticatedUser,
): Promise<WorkspaceContext | null | undefined> {
  let workspaceId: string | undefined;
  try {
    const session = await Session.findById(sessionId).select('workspaceId').lean();
    if (!session) return null;
    workspaceId = session.workspaceId ? String(session.workspaceId) : undefined;
  } catch {
    // 非法 ObjectId（CastError）等一律按不存在处理
    return null;
  }

  if (!workspaceId) return undefined;

  try {
    return await resolveWorkspaceContext(user, workspaceId);
  } catch {
    return null;
  }
}

router.get('/session/:id/stream', async (req: Request, res: Response) => {
  const currentUser = await authenticateExpressUser(req);
  if (!currentUser) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const sessionId = req.params.id as string;
  const workspace = await resolveSessionWorkspace(sessionId, currentUser);
  if (workspace === null) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  await runWithWorkspace(workspace, () =>
    sessionSSEService.addConnection(sessionId, currentUser.id, res),
  );
});

// 用户级事件流（不绑定会话）：登录引导等全局事件即时下发；HOME_OVERVIEW 轮询仍为兜底
router.get('/user/stream', async (req: Request, res: Response) => {
  const currentUser = await authenticateExpressUser(req);
  if (!currentUser) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  sessionSSEService.addUserConnection(currentUser.id, res);
});

export const sessionStreamRouter = router;
