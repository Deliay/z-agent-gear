import { Router, type Request, type Response } from 'express';
import { config } from '../config/index.js';
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
    const userId = await redis.get(`github:oauth:state:${state}`);
    if (!userId) {
      res.redirect(`${config.frontendUrl}/settings?binding=error&message=invalid_state`);
      return;
    }

    await redis.del(`github:oauth:state:${state}`);

    await githubService.handleSetup({
      installationId,
      state: state as string,
      userId: userId as string,
    });

    res.redirect(`${config.frontendUrl}/settings?binding=success`);
  } catch (error) {
    console.error('GitHub setup error:', error);
    res.redirect(`${config.frontendUrl}/settings?binding=error&message=internal_error`);
  }
}

export const githubRouter = Router();
githubRouter.get('/github/setup', handleGithubSetup);
