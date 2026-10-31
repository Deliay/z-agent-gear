/**
 * 测试支撑：内存 sink 的 `createTestLogger()`（仅被测试引用，不进运行时入口）。
 *
 * `records` 为逐行 `JSON.parse` 后的对象数组（引用稳定，`reset()` 原地清空）；
 * 断言应针对结构化字段（`msg`/`component`/`err` 等），不要断言拼接字符串。
 */
import type { Logger as PinoLogger } from 'pino';
import { createLogger, type LogLevel } from './logger.js';

export interface TestLogRecord {
  level: string;
  time: string;
  msg: string;
  [key: string]: unknown;
}

export interface TestLogger {
  logger: PinoLogger;
  records: TestLogRecord[];
  reset(): void;
}

/**
 * 创建测试 logger：默认 `debug` 级别（不被 `LOG_LEVEL` 过滤），输出进内存。
 */
export function createTestLogger(component?: string, level: LogLevel = 'debug'): TestLogger {
  const records: TestLogRecord[] = [];
  const logger = createLogger({
    component,
    level,
    destination: {
      write(line: string): boolean {
        try {
          records.push(JSON.parse(line) as TestLogRecord);
        } catch {
          // 非法行不应出现；忽略以保持测试稳定
        }
        return true;
      },
    },
  });
  return {
    logger,
    records,
    reset() {
      records.length = 0;
    },
  };
}
