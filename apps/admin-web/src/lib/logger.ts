/**
 * 前端统一日志出口 —— apps/admin-web 全包唯一的 console 调用点。
 *
 * - 生产默认静默：仅当 `import.meta.env.DEV` 或显式设置 `VITE_LOG_LEVEL` 时输出；
 * - 级别过滤：`VITE_LOG_LEVEL`（debug|info|warn|error，非法值回落 info；DEV 默认 debug）；
 * - 调用签名与后端 pino 一致：`logger.<level>(objOrMsg, msg?)`——第一参可为对象或字符串，
 *   变量进对象字段、msg 为固定短语，错误对象一律进 `err` 字段。
 *
 * 除本文件外，业务代码禁止直接调用 console.*（vite.config.ts 的构建期提示为登记例外）。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: readonly string[] = ['debug', 'info', 'warn', 'error'];
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const rawLevel = import.meta.env.VITE_LOG_LEVEL as string | undefined;
const enabled = import.meta.env.DEV || Boolean(rawLevel);
const minLevel: LogLevel = LEVELS.includes(rawLevel ?? '')
  ? (rawLevel as LogLevel)
  : rawLevel
    ? 'info' // 非法 VITE_LOG_LEVEL 回落 info
    : 'debug'; // DEV 默认 debug

function log(level: LogLevel, objOrMsg: object | string, msg?: string): void {
  if (!enabled || LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const args: unknown[] =
    typeof objOrMsg === 'string'
      ? msg === undefined ? [objOrMsg] : [objOrMsg, msg]
      : msg === undefined ? [objOrMsg] : [msg, objOrMsg];
  // ↓↓↓ 全包唯一的 console 调用点 ↓↓↓
  if (level === 'debug') console.debug(...args);
  else if (level === 'info') console.info(...args);
  else if (level === 'warn') console.warn(...args);
  else console.error(...args);
}

export const logger = {
  debug: (objOrMsg: object | string, msg?: string): void => log('debug', objOrMsg, msg),
  info: (objOrMsg: object | string, msg?: string): void => log('info', objOrMsg, msg),
  warn: (objOrMsg: object | string, msg?: string): void => log('warn', objOrMsg, msg),
  error: (objOrMsg: object | string, msg?: string): void => log('error', objOrMsg, msg),
};
