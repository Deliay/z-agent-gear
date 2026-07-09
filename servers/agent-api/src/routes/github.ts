import { Router, type Request, type Response } from 'express';
import { config } from '../config/index.js';
import { getRedisClient } from '../middleware/redis.js';
import { githubService } from '../services/github.js';

export async function handleGithubCallback(req: Request, res: Response): Promise<void> {
  try {
    const { installation_id, state } = req.query;

    if (!installation_id || !state) {
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

    await githubService.handleCallback({
      installationId: parseInt(installation_id as string, 10),
      state: state as string,
      userId: userId as string,
    });

    res.redirect(`${config.frontendUrl}/settings?binding=success`);
  } catch (error) {
    console.error('GitHub callback error:', error);
    res.redirect(`${config.frontendUrl}/settings?binding=error&message=internal_error`);
  }
}

export const githubRouter = Router();
githubRouter.get('/github/callback', handleGithubCallback);
