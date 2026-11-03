import { Router, type Request, type Response } from 'express';
import { config } from '../config/index.js';
import { logger as rootLogger } from '../observability/logger.js';
import { getRedisClient } from '../middleware/redis.js';
import { githubService } from '../services/github.js';

export async function handleGithubSetup(req: Request, res: Response): Promise<void> {
  try {
    const { installation_id, setup_action, state } = req.query;

    if (!installation_id) {
      res.redirect(`${config.frontendUrl}/settings?binding=error&message=missing_params`);
      return;
    }

    const installationId = parseInt(installation_id as string, 10);

    if (setup_action === 'update' && !state) {
      await githubService.handleSetupUpdate(installationId);
      res.redirect(`${config.frontendUrl}/settings?binding=success`);
      return;
    }

    if (!state) {
      res.redirect(`${config.frontendUrl}/settings?binding=error&message=missing_params`);
      return;
    }

    const redis = await getRedisClient();
    const rawState = await redis.get(`github:oauth:state:${state}`);
    if (!rawState) {
      res.redirect(`${config.frontendUrl}/settings?binding=error&message=invalid_state`);
      return;
    }

    await redis.del(`github:oauth:state:${state}`);

    // 多租户二期：state 携带发起绑定的工作区（兼容一期纯 userId 的旧 state）
    let userId = rawState;
    let workspaceId: string | undefined;
    try {
      const parsed = JSON.parse(rawState) as { userId?: unknown; workspaceId?: unknown };
      if (parsed && typeof parsed.userId === 'string') {
        userId = parsed.userId;
        workspaceId = typeof parsed.workspaceId === 'string' && parsed.workspaceId
          ? parsed.workspaceId
          : undefined;
      }
    } catch {
      // 旧格式：state 值为 userId
    }

    await githubService.handleSetup({
      installationId,
      state: state as string,
      userId,
      workspaceId,
    });

    res.redirect(`${config.frontendUrl}/settings?binding=success`);
  } catch (error) {
    rootLogger.error({ component: 'github-route', err: error }, 'GitHub setup error');
    res.redirect(`${config.frontendUrl}/settings?binding=error&message=internal_error`);
  }
}

export const githubRouter = Router();
githubRouter.get('/github/setup', handleGithubSetup);
