/**
 * 运行期模型下发的凭据兜底读取。
 *
 * 云电脑 Job env **不携带**模型 Key/BaseURL（只经 `workload:run.env` 注入脚本进程），
 * 因此 `harness:models` 事件链路优先取进程 env，其次回读**已写入的** harness 配置：
 *
 * - `opencode.jsonc|json` 的 `providers.zag.settings`；
 * - `cordis.patch.yml` 的 `llm-pi-ai.config.providers.zag.baseURL` +
 *   `.credentials.yaml` 的 `refs.ZAG_MODEL_API_KEY`。
 *
 * 只读、不写；任何读取失败都收敛为「缺失」，由调用方按变量名报错。
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import { parse as parseYaml } from 'yaml';
import { defaultDshHome } from './dsh-config.js';
import { defaultConfigDir } from './opencode-config.js';

/** 运行期重写需要的网关凭据（禁止打印）。 */
export interface ConfiguredModelCredentials {
  modelBaseUrl: string;
  modelApiKey: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readOpencodeCredentials(configDir: string): Promise<Partial<ConfiguredModelCredentials>> {
  return (async () => {
    for (const fileName of ['opencode.jsonc', 'opencode.json']) {
      try {
        const text = await readFile(join(configDir, fileName), 'utf-8');
        const parsed = parseJsonc(text, [], { allowTrailingComma: true }) as unknown;
        const providers = isRecord(parsed) ? parsed.providers : undefined;
        const zag = isRecord(providers) ? providers.zag : undefined;
        const settings = isRecord(zag) ? zag.settings : undefined;
        if (!isRecord(settings)) return {};
        return {
          modelBaseUrl: nonEmptyString(settings.baseURL),
          modelApiKey: nonEmptyString(settings.apiKey),
        };
      } catch {
        // 文件不存在/不可读：尝试同名 .json
      }
    }
    return {};
  })();
}

function readDshBaseUrl(patchPath: string): Promise<string> {
  return (async () => {
    try {
      const patch = parseYaml(await readFile(patchPath, 'utf-8')) as unknown;
      if (!Array.isArray(patch)) return '';
      for (const entry of patch) {
        if (!isRecord(entry)) continue;
        const config = entry.config;
        const providers = isRecord(config) ? config.providers : undefined;
        const zag = isRecord(providers) ? providers.zag : undefined;
        const baseURL = isRecord(zag) ? nonEmptyString(zag.baseURL) : '';
        if (baseURL) return baseURL;
      }
    } catch {
      // 忽略：调用方按缺失凭据报错
    }
    return '';
  })();
}

function readDshApiKey(credentialsPath: string): Promise<string> {
  return (async () => {
    try {
      const credentials = parseYaml(await readFile(credentialsPath, 'utf-8')) as unknown;
      const refs = isRecord(credentials) ? credentials.refs : undefined;
      return isRecord(refs) ? nonEmptyString(refs.ZAG_MODEL_API_KEY) : '';
    } catch {
      return '';
    }
  })();
}

/**
 * 解析运行期模型凭据：进程 env 优先，缺失项从已写入配置回读（逐项兜底）。
 */
export async function resolveConfiguredCredentials(
  options: {
    env?: NodeJS.ProcessEnv;
    configDir?: string;
    dshHome?: string;
  } = {},
): Promise<ConfiguredModelCredentials> {
  const source = options.env ?? process.env;
  let modelBaseUrl = nonEmptyString(source.ZAG_MODEL_BASE_URL);
  let modelApiKey = nonEmptyString(source.ZAG_MODEL_API_KEY);
  if (modelBaseUrl && modelApiKey) return { modelBaseUrl, modelApiKey };

  const opencode = await readOpencodeCredentials(options.configDir ?? defaultConfigDir());
  if (!modelBaseUrl) modelBaseUrl = opencode.modelBaseUrl ?? '';
  if (!modelApiKey) modelApiKey = opencode.modelApiKey ?? '';
  if (modelBaseUrl && modelApiKey) return { modelBaseUrl, modelApiKey };

  const dshHome = options.dshHome ?? defaultDshHome(source);
  if (!modelBaseUrl) {
    modelBaseUrl = await readDshBaseUrl(join(dshHome, 'profiles', 'acp', 'cordis.patch.yml'));
  }
  if (!modelApiKey) {
    modelApiKey = await readDshApiKey(join(dshHome, '.credentials.yaml'));
  }

  return { modelBaseUrl, modelApiKey };
}
