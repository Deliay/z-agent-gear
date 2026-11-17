import { config } from '../config/index.js';
import { logger as rootLogger } from '../observability/logger.js';

const logger = rootLogger.child({ component: 'model-push-notifier' });

/** 通知 agent-api 全量刷新模型下发（超出即视为失败，仅告警不影响调用方）。 */
const NOTIFY_TIMEOUT_MS = 5_000;

/**
 * 后台全局模型/供应商变更后通知 agent-api 全量下发（`POST /internal/model-config/refresh`）。
 *
 * - 未配置 `AGENT_API_URL` / `INTERNAL_API_TOKEN` → `warn` 并返回（本地开发/单服务场景）；
 * - **fire-and-forget**：内部吞掉所有错误（非 2xx、超时、网络异常）仅 `warn`，绝不抛给调用方，
 *   保证 GraphQL mutation 的成功语义不被下发链路阻塞或翻转；
 * - resolver 以 `void notifyModelConfigChanged()` 调用即可。
 */
export async function notifyModelConfigChanged(): Promise<void> {
  if (!config.agentApiUrl || !config.internalApiToken) {
    logger.warn(
      {
        hasAgentApiUrl: Boolean(config.agentApiUrl),
        hasInternalApiToken: Boolean(config.internalApiToken),
      },
      'model config refresh skipped: agent-api not configured',
    );
    return;
  }

  try {
    const response = await fetch(`${config.agentApiUrl}/internal/model-config/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.internalApiToken}`,
      },
      body: JSON.stringify({ scope: 'global' }),
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    });
    if (!response.ok) {
      logger.warn({ status: response.status }, 'model config refresh rejected');
    }
  } catch (err) {
    logger.warn({ err }, 'model config refresh failed');
  }
}
