import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  applyEdits,
  modify,
  parse,
  printParseErrorCode,
  type FormattingOptions,
  type ParseError,
} from 'jsonc-parser';
import type { HarnessEnv } from './env.js';

/** OpenCode 配置中 `provider.zag` 的结构（OpenAI-compatible 自定义 provider）。 */
export interface ZagProviderConfig {
  npm: string;
  name: string;
  options: {
    baseURL: string;
    apiKey: string;
  };
  models: Record<string, { name: string }>;
}

/** 写入 OpenCode 配置失败（消息只含路径/变量名，不含 key 等 secret）。 */
export class OpencodeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpencodeConfigError';
  }
}

/** `provider.zag` 固定使用 OpenAI compatible provider 包。 */
export const ZAG_PROVIDER_NPM = '@ai-sdk/openai-compatible';

/** 由 harness env 构造 `provider.zag`（模型列表为空时 `models: {}`）。 */
export function buildZagProvider(
  env: Pick<HarnessEnv, 'modelBaseUrl' | 'modelApiKey' | 'modelIds'>,
): ZagProviderConfig {
  const models: Record<string, { name: string }> = {};
  for (const id of env.modelIds) {
    if (!id) continue;
    models[id] = { name: id };
  }
  return {
    npm: ZAG_PROVIDER_NPM,
    name: 'ZAG',
    options: {
      baseURL: env.modelBaseUrl,
      apiKey: env.modelApiKey,
    },
    models,
  };
}

/** 默认配置目录：`~/.config/opencode`。 */
export function defaultConfigDir(): string {
  return join(homedir(), '.config', 'opencode');
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 选择配置目标文件（A13）：
 *
 * 1. 同目录存在 `opencode.jsonc` → 用它；
 * 2. 否则同目录只存在 `opencode.json` → 合并该文件（不另建 `.jsonc`）；
 * 3. 都不存在 → 新建 `opencode.jsonc`。
 */
export async function resolveOpencodeConfigPath(configDir = defaultConfigDir()): Promise<string> {
  const jsoncPath = join(configDir, 'opencode.jsonc');
  if (await exists(jsoncPath)) return jsoncPath;
  const jsonPath = join(configDir, 'opencode.json');
  if (await exists(jsonPath)) return jsonPath;
  return jsoncPath;
}

export interface WriteOpencodeConfigOptions {
  env: Pick<HarnessEnv, 'modelBaseUrl' | 'modelApiKey' | 'modelIds'>;
  /** 覆盖配置目录（测试/定制场景；缺省 `~/.config/opencode`）。 */
  configDir?: string;
}

export interface WriteOpencodeConfigResult {
  /** 实际写入的配置文件路径。 */
  path: string;
  /** 是否为新建文件。 */
  created: boolean;
  /** 写入的模型数量。 */
  modelCount: number;
}

/**
 * 写入/合并 OpenCode 配置：
 *
 * - 用 `jsonc-parser` 的 `modify` 仅替换 `provider.zag`，保留注释与既有 provider；
 * - 文件权限固定 `0600`（含已存在文件），目录权限收紧为 `0700`（含已存在目录）；
 * - 同目录临时文件 + `rename` 原子替换（避免半写文件，C-7）；
 * - 非法 JSONC 直接报错（不覆盖用户配置，避免静默丢数据）。
 */
export async function writeOpencodeConfig(
  options: WriteOpencodeConfigOptions,
): Promise<WriteOpencodeConfigResult> {
  const dir = options.configDir ?? defaultConfigDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // `mkdir` 的 mode 只对新建目录生效：已存在目录显式收紧到 0700（可能含模型 Key）。
  try {
    await chmod(dir, 0o700);
  } catch (error) {
    throw new OpencodeConfigError(
      `cannot set permissions on OpenCode config directory ${dir}: ${(error as Error).message}`,
    );
  }

  const target = await resolveOpencodeConfigPath(dir);
  const created = !(await exists(target));

  let text = '';
  if (!created) {
    try {
      text = await readFile(target, 'utf-8');
    } catch (error) {
      throw new OpencodeConfigError(`cannot read OpenCode config at ${target}: ${(error as Error).message}`);
    }
  }
  if (text.trim().length === 0) {
    text = '{}\n';
  }

  const parseErrors: ParseError[] = [];
  const parsed = parse(text, parseErrors, { allowTrailingComma: true });
  if (parseErrors.length > 0) {
    const first = parseErrors[0];
    throw new OpencodeConfigError(
      `cannot parse OpenCode config at ${target}: ${printParseErrorCode(first.error)} at offset ${first.offset}`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new OpencodeConfigError(`invalid OpenCode config at ${target}: expected a JSON object`);
  }

  const formattingOptions: FormattingOptions = {
    insertSpaces: true,
    tabSize: 2,
    eol: text.includes('\r\n') ? '\r\n' : '\n',
  };
  const provider = buildZagProvider(options.env);
  const edits = modify(text, ['provider', 'zag'], provider, { formattingOptions });
  let content = applyEdits(text, edits);
  if (!content.endsWith('\n')) content += '\n';

  const tempPath = join(dir, `.opencode-config.${process.pid}.${randomUUID()}.tmp`);
  try {
    // 先写同目录临时文件（0600）再 rename：失败时原配置保持完整，不产生半写文件。
    await writeFile(tempPath, content, { encoding: 'utf-8', mode: 0o600 });
    await chmod(tempPath, 0o600);
    await rename(tempPath, target);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw new OpencodeConfigError(`cannot write OpenCode config at ${target}: ${(error as Error).message}`);
  }

  return {
    path: target,
    created,
    modelCount: Object.keys(provider.models).length,
  };
}
