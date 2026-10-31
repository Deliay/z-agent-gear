// GENERATED FROM packages/observability/src/register.ts — DO NOT EDIT

/**
 * 入口副作用模块：**服务入口的第一个 import**。
 *
 * `import './observability/register.js'` 必须位于 express/mongoose 等之前，
 * 否则自动埋点失效（backend-rules 陷阱条款）。
 *
 * - 启动 OTel SDK（未配置 endpoint 完全不启动）；
 * - 兜底 `uncaughtException`（logger.fatal 后 exit(1)）/ `unhandledRejection`（logger.error）；
 * - 不加载 dotenv（由各包 `config/index.ts` 负责，D3）；幂等。
 */
import { logger } from './logger.js';
import { startTelemetry } from './telemetry.js';

let started = false;

export function register(): void {
  if (started) return;
  started = true;
  startTelemetry();
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception, exiting');
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error(
      { err: reason instanceof Error ? reason : new Error(String(reason)) },
      'unhandled rejection',
    );
  });
}

register();
