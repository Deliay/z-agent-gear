import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Document, isMap, isSeq, parseDocument, type YAMLMap, type YAMLSeq } from 'yaml';
import type { HarnessEnv } from './env.js';

/** dsh 凭据 env 引用名（值只写 `.credentials.yaml` 的 `refs`）。 */
export const ZAG_API_KEY_ENV = 'ZAG_MODEL_API_KEY';

/** dsh ACP profile 名（`dsh --profile acp`）。 */
export const DSH_ACP_PROFILE = 'acp';

/** dsh ACP profile 组合包名（写入 patch 的 `acp` 条目）。 */
export const DSH_ACP_APP_NAME = '@deepseek-ai/dsh-acp';

/** 我方在 `cordis.patch.yml` 中维护的 4 个条目（按此顺序写入，按 id 替换）。 */
export const DSH_PATCH_ENTRY_IDS = [
  'llm-deepseek',
  'llm-pi-ai',
  'agent-default-model',
  'acp',
] as const;

/** 写入 dsh 配置失败（消息只含路径/条目名，不含 API Key 等 secret）。 */
export class DshConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DshConfigError';
  }
}

type DshConfigEnv = Pick<
  HarnessEnv,
  'modelBaseUrl' | 'modelApiKey' | 'modelIds'
> &
  Partial<Pick<HarnessEnv, 'modelContextLengths'>>;

export interface WriteDshConfigOptions {
  env: DshConfigEnv;
  /** 覆盖 dsh home（缺省 `$DSH_HOME` 或 `~/.dsh`）。 */
  dshHome?: string;
}

export interface WriteDshConfigResult {
  /** `cordis.patch.yml` 实际路径。 */
  patchPath: string;
  /** `.credentials.yaml` 实际路径。 */
  credentialsPath: string;
  /** patch 是否新建。 */
  patchCreated: boolean;
  /** credentials 是否新建。 */
  credentialsCreated: boolean;
  /** 写入的模型数量。 */
  modelCount: number;
  /** patch 中我方维护的条目数（固定 4）。 */
  entryCount: number;
}

/** 默认 dsh home：`$DSH_HOME` 优先，否则 `~/.dsh`。 */
export function defaultDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  return configured || join(homedir(), '.dsh');
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** `llm-pi-ai.providers.zag`：模型清单整体替换，`contextWindow` 仅在正整数时写入。 */
function buildZagProvider(env: DshConfigEnv): Record<string, unknown> {
  const models = env.modelIds.map((id) => {
    const context = env.modelContextLengths?.[id];
    return typeof context === 'number' && Number.isInteger(context) && context > 0
      ? { id, name: id, contextWindow: context }
      : { id, name: id };
  });
  return {
    displayName: 'ZAG',
    apiKeyEnv: ZAG_API_KEY_ENV,
    api: 'openai-completions',
    baseURL: env.modelBaseUrl,
    models,
  };
}

/** 我方 patch 条目（按 id；默认模型取 `modelIds[0]`，空清单不写 `model`）。 */
function buildEntry(id: (typeof DSH_PATCH_ENTRY_IDS)[number], env: DshConfigEnv): Record<string, unknown> {
  const defaultModel = env.modelIds[0];
  switch (id) {
    case 'llm-deepseek':
      return { id, disabled: true };
    case 'llm-pi-ai':
      return { id, config: { providers: { zag: buildZagProvider(env) } } };
    case 'agent-default-model':
      return {
        id,
        config: defaultModel ? { provider: 'zag', model: defaultModel } : { provider: 'zag' },
      };
    case 'acp':
      return {
        id,
        name: DSH_ACP_APP_NAME,
        config: defaultModel ? { provider: 'zag', model: defaultModel } : { provider: 'zag' },
      };
    default:
      throw new DshConfigError(`unsupported dsh patch entry: ${String(id)}`);
  }
}

function parsePatchDocument(text: string, path: string): Document {
  if (text.trim().length === 0) return new Document([]);
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    const code = (doc.errors[0] as { code?: string }).code ?? 'PARSE_ERROR';
    throw new DshConfigError(`cannot parse dsh patch at ${path}: ${code}`);
  }
  if (doc.contents === null) return new Document([]);
  if (!isSeq(doc.contents)) {
    throw new DshConfigError(`invalid dsh patch at ${path}: expected a top-level array`);
  }
  return doc;
}

/**
 * 合并 `cordis.patch.yml`：
 *
 * - 顶层条目数组，按 `id` 定位我方 4 个条目并**整体替换其 config**；
 * - 其余条目与注释逐字保留（新条目追加在末尾）；
 * - 解析失败抛错、不写文件（不静默丢数据）。
 */
function mergePatchDocument(doc: Document, env: DshConfigEnv): { content: string; entryCount: number } {
  const seq = doc.contents as YAMLSeq;
  const findIndex = (id: string): number =>
    seq.items.findIndex((item) => isMap(item) && item.get('id') === id);

  for (const id of DSH_PATCH_ENTRY_IDS) {
    const entry = buildEntry(id, env);
    const index = findIndex(id);
    if (index === -1) {
      seq.add(doc.createNode(entry));
      continue;
    }
    if (id === 'llm-deepseek') {
      doc.setIn([index, 'disabled'], true);
      continue;
    }
    const config = entry.config as Record<string, unknown>;
    doc.setIn([index, 'config'], doc.createNode(config));
    if (id === 'acp') doc.setIn([index, 'name'], DSH_ACP_APP_NAME);
  }

  let content = doc.toString();
  if (!content.endsWith('\n')) content += '\n';
  return { content, entryCount: DSH_PATCH_ENTRY_IDS.length };
}

/**
 * 合并 `.credentials.yaml`：
 *
 * - 已有文件只替换 `refs.ZAG_MODEL_API_KEY`，保留其他 `refs`/`records` 与注释；
 * - 新建写 `{ version: 1, refs: { ZAG_MODEL_API_KEY } }`；
 * - 永远写 `version: 1`（旧扁平格式由 dsh 迁移，我方不写）；
 * - 非法 YAML / 非 mapping 抛错不覆盖。
 */
function mergeCredentialsDocument(
  text: string,
  path: string,
  env: DshConfigEnv,
): string {
  let doc: Document;
  if (text.trim().length === 0) {
    doc = new Document({ version: 1, refs: {} });
  } else {
    doc = parseDocument(text);
    if (doc.errors.length > 0) {
      const code = (doc.errors[0] as { code?: string }).code ?? 'PARSE_ERROR';
      throw new DshConfigError(`cannot parse dsh credentials at ${path}: ${code}`);
    }
    if (doc.contents === null) {
      doc = new Document({ version: 1, refs: {} });
    } else if (!isMap(doc.contents)) {
      throw new DshConfigError(`invalid dsh credentials at ${path}: expected a mapping`);
    }
  }

  const root = doc.contents as YAMLMap;
  root.set('version', 1);
  const refs = root.get('refs');
  if (refs === undefined || refs === null) {
    root.set('refs', doc.createNode({}));
  } else if (!isMap(refs)) {
    throw new DshConfigError(`invalid dsh credentials at ${path}: refs must be a mapping`);
  }
  const refsMap = root.get('refs') as YAMLMap;
  refsMap.set(ZAG_API_KEY_ENV, env.modelApiKey);

  let content = doc.toString();
  if (!content.endsWith('\n')) content += '\n';
  return content;
}

/** 同目录临时文件 + rename 原子替换；失败时清理临时文件、原文件保持完整。 */
async function atomicWrite(path: string, dir: string, content: string, label: string): Promise<void> {
  const tempPath = join(dir, `.${label}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, content, { encoding: 'utf-8', mode: 0o600 });
    await chmod(tempPath, 0o600);
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw new DshConfigError(`cannot write ${label} at ${path}: ${(error as Error).message}`);
  }
}

async function readText(path: string, label: string): Promise<{ text: string; created: boolean }> {
  if (!(await exists(path))) return { text: '', created: true };
  try {
    return { text: await readFile(path, 'utf-8'), created: false };
  } catch (error) {
    throw new DshConfigError(`cannot read ${label} at ${path}: ${(error as Error).message}`);
  }
}

/**
 * 写入/合并 dsh 平台渠道模型注入（计划 §3.2.1 / §3.2.2）：
 *
 * 1. `~/.dsh/profiles/acp/cordis.patch.yml`（目录 0700、文件 0600）；
 * 2. `~/.dsh/.credentials.yaml`（0600）；
 * 3. 两文件均走临时文件 + `rename` 原子替换，失败不破坏既有文件；
 * 4. secret 只落凭据文件，不进入返回值/错误信息。
 */
export async function writeDshConfig(
  options: WriteDshConfigOptions,
): Promise<WriteDshConfigResult> {
  const envSource = options.env as DshConfigEnv & { DSH_HOME?: string };
  const dshHome =
    options.dshHome ?? defaultDshHome(envSource as unknown as NodeJS.ProcessEnv);
  const profilesDir = join(dshHome, 'profiles', DSH_ACP_PROFILE);
  const patchPath = join(profilesDir, 'cordis.patch.yml');
  const credentialsPath = join(dshHome, '.credentials.yaml');

  try {
    await mkdir(profilesDir, { recursive: true, mode: 0o700 });
    // `mkdir` 的 mode 只对新建目录生效：已存在目录显式收紧到 0700。
    await chmod(profilesDir, 0o700);
  } catch (error) {
    throw new DshConfigError(
      `cannot set permissions on dsh profile directory ${profilesDir}: ${(error as Error).message}`,
    );
  }

  const patchFile = await readText(patchPath, 'dsh patch');
  const patchDoc = parsePatchDocument(patchFile.text, patchPath);
  const mergedPatch = mergePatchDocument(patchDoc, options.env);

  const credentialsFile = await readText(credentialsPath, 'dsh credentials');
  const credentialsContent = mergeCredentialsDocument(
    credentialsFile.text,
    credentialsPath,
    options.env,
  );

  await atomicWrite(patchPath, profilesDir, mergedPatch.content, 'cordis.patch');
  await atomicWrite(credentialsPath, dshHome, credentialsContent, 'dsh-credentials');

  return {
    patchPath,
    credentialsPath,
    patchCreated: patchFile.created,
    credentialsCreated: credentialsFile.created,
    modelCount: options.env.modelIds.length,
    entryCount: mergedPatch.entryCount,
  };
}
