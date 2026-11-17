import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  applyEdits,
  modify,
  parse,
  printParseErrorCode,
  type FormattingOptions,
  type ParseError,
} from 'jsonc-parser';
import type { HarnessEnv } from './env.js';
import {
  normalizeProvision,
  resolveProvision,
  ZAG_VENDOR_ID,
  ZAG_DISPLAY_NAME,
  type ModelProvision,
} from './model-providers.js';
import { logger } from '../observability/logger.js';

/** OpenCode 配置中受管 provider 的结构（OpenCode v2 OpenAI-compatible 自定义 provider）。 */
export interface OpencodeProviderConfig {
  package: string;
  name: string;
  settings: {
    baseURL: string;
    apiKey: string;
  };
  models: Record<string, { name: string; limit?: { context: number } }>;
}

/** 写入 OpenCode 配置失败（消息只含路径/变量名，不含 key 等 secret）。 */
export class OpencodeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpencodeConfigError';
  }
}

/** 受管 provider 固定使用 OpenCode v2 OpenAI compatible provider 包。 */
export const ZAG_PROVIDER_PACKAGE = '@opencode/ai/providers/openai-compatible';

/** 上次写入的 vendorId 状态文件（相对 `~/.zag`）。 */
export const MODEL_PROVIDERS_STATE_FILENAME = 'model-providers-state.json';

/** 运行期模型清单的旧字段回退来源（`ZAG_MODEL_IDS` 等）。 */
export type OpencodeConfigEnv = Pick<HarnessEnv, 'modelBaseUrl' | 'modelApiKey'> &
  Partial<Pick<HarnessEnv, 'modelIds' | 'modelContextLengths' | 'modelProviders'>>;

function buildProvider(
  provider: ModelProvision['providers'][number],
  env: Pick<HarnessEnv, 'modelBaseUrl' | 'modelApiKey'>,
): OpencodeProviderConfig {
  const models: Record<string, { name: string; limit?: { context: number } }> = {};
  for (const model of provider.models) {
    const id = model.id.trim();
    if (!id) continue;
    const context = model.contextLength;
    models[id] =
      typeof context === 'number' && Number.isInteger(context) && context > 0
        ? { name: id, limit: { context } }
        : { name: id };
  }
  return {
    package: ZAG_PROVIDER_PACKAGE,
    name: provider.displayName,
    settings: {
      baseURL: env.modelBaseUrl,
      apiKey: env.modelApiKey,
    },
    models,
  };
}

/**
 * 由模型清单构造全部受管 provider（多 vendor）：
 *
 * - key = `vendorId`，`name = displayName`（`zag` 恒 `Agent Gear`）；
 * - `package` 与 `settings` 保持现状（平台网关地址/Key 对所有分组一致）；
 * - `models.<id>.limit.context` 仅在正整数上下文时写入；
 * - `zag` 组恒存在（可为空 `models: {}`）。
 */
export function buildProviders(
  provision: ModelProvision,
  env: Pick<HarnessEnv, 'modelBaseUrl' | 'modelApiKey'>,
): Record<string, OpencodeProviderConfig> {
  const normalized = normalizeProvision(provision);
  const providers: Record<string, OpencodeProviderConfig> = {};
  for (const provider of normalized.providers) {
    providers[provider.vendorId] = buildProvider(provider, env);
  }
  // 兜底：normalizeProvision 保证 zag 恒存在且首位
  if (!providers[ZAG_VENDOR_ID]) {
    providers[ZAG_VENDOR_ID] = buildProvider(
      { vendorId: ZAG_VENDOR_ID, displayName: ZAG_DISPLAY_NAME, models: [] },
      env,
    );
  }
  return providers;
}

/** 默认配置目录：`~/.config/opencode`。 */
export function defaultConfigDir(): string {
  return join(homedir(), '.config', 'opencode');
}

/** 默认状态文件：`~/.zag/model-providers-state.json`。 */
export function defaultModelProvidersStatePath(): string {
  return join(homedir(), '.zag', MODEL_PROVIDERS_STATE_FILENAME);
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

/**
 * 读取上次写入的 vendorId 集合（D12）。
 *
 * 文件缺失/损坏/结构非法一律按**空集合**处理：只影响后续差集清理（不误删用户 provider）。
 */
export async function readModelProvidersState(statePath: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(statePath, 'utf-8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    const vendors = (parsed as { vendors?: unknown }).vendors;
    if (!Array.isArray(vendors)) return [];
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const item of vendors) {
      if (typeof item !== 'string') continue;
      const value = item.trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      unique.push(value);
    }
    return unique;
  } catch {
    return [];
  }
}

/** 原子写入状态文件（0600；失败由调用方仅告警，不影响配置写入）。 */
export async function writeModelProvidersState(
  statePath: string,
  vendors: string[],
): Promise<void> {
  const dir = dirname(statePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tempPath = join(dir, `.${MODEL_PROVIDERS_STATE_FILENAME}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, `${JSON.stringify({ version: 1, vendors }, null, 2)}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    });
    await chmod(tempPath, 0o600);
    await rename(tempPath, statePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

export interface WriteOpencodeConfigOptions {
  env: OpencodeConfigEnv;
  /** 显式模型清单（运行期下发）；缺省由 env 投影（向后兼容）。 */
  provision?: ModelProvision;
  /** 覆盖配置目录（测试/定制场景；缺省 `~/.config/opencode`）。 */
  configDir?: string;
  /** 覆盖状态文件（缺省 `~/.zag/model-providers-state.json`）。 */
  statePath?: string;
  /** 状态文件写失败回调（缺省仅告警）。 */
  onStateWriteError?: (error: Error) => void;
}

export interface WriteOpencodeConfigResult {
  /** 实际写入的配置文件路径。 */
  path: string;
  /** 是否为新建文件。 */
  created: boolean;
  /** 写入的模型数量（全部 vendor 的模型合计）。 */
  modelCount: number;
  /** 本次写入的 vendorId（含 `zag`）。 */
  vendors: string[];
}

/**
 * 写入/合并 OpenCode 配置：
 *
 * - 用 `jsonc-parser` 的 `modify` 逐个替换/写入 `providers.<vendorId>`，保留注释与其他 provider；
 * - 按状态文件差集删除「上次有、本次无」的受管 vendor（package 不匹配的用户手写 provider 不删）；
 * - `providers.zag` 恒写（D4）；
 * - 文件权限固定 `0600`（含已存在文件），目录权限收紧为 `0700`（含已存在目录）；
 * - 同目录临时文件 + `rename` 原子替换（避免半写文件，C-7）；
 * - 状态文件写失败仅告警（配置正确性优先，D12）；
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
  const provision = options.provision ?? resolveProvision(options.env);
  const providers = buildProviders(provision, options.env);
  const vendorIds = Object.keys(providers);

  let content = text;
  for (const vendorId of vendorIds) {
    content = applyEdits(
      content,
      modify(content, ['providers', vendorId], providers[vendorId], { formattingOptions }),
    );
  }

  // 差集清理：仅删除「我们上次写过、本次不再出现」且 package 仍为受管包的 vendor，
  // 避免误删用户手写 provider（状态文件是优化项，配置正确性优先）。
  const statePath = options.statePath ?? defaultModelProvidersStatePath();
  const previousVendors = await readModelProvidersState(statePath);
  const current = new Set(vendorIds);
  for (const vendorId of previousVendors) {
    if (current.has(vendorId) || vendorId === ZAG_VENDOR_ID) continue;
    const existing = parsed as Record<string, unknown>;
    const existingProviders = existing.providers;
    const existingProvider =
      existingProviders !== null &&
      typeof existingProviders === 'object' &&
      !Array.isArray(existingProviders)
        ? (existingProviders as Record<string, unknown>)[vendorId]
        : undefined;
    const existingPackage =
      existingProvider !== null &&
      typeof existingProvider === 'object' &&
      !Array.isArray(existingProvider)
        ? (existingProvider as Record<string, unknown>).package
        : undefined;
    if (existingPackage !== ZAG_PROVIDER_PACKAGE) continue;
    content = applyEdits(
      content,
      modify(content, ['providers', vendorId], undefined, { formattingOptions }),
    );
  }

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

  // 状态文件是差集清理的优化项：写失败仅告警，配置写入已经成功（D12）。
  try {
    await writeModelProvidersState(statePath, vendorIds);
  } catch (error) {
    const notify = options.onStateWriteError;
    if (notify) {
      notify(error as Error);
    } else {
      logger.warn(
        { event: 'model_providers_state_write_failed', statePath, err: error as Error },
        'failed to write model provider state; stale vendors may remain',
      );
    }
  }

  return {
    path: target,
    created,
    modelCount: Object.values(providers).reduce(
      (count, provider) => count + Object.keys(provider.models).length,
      0,
    ),
    vendors: vendorIds,
  };
}
