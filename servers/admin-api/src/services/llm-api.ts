import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

export type ProviderType = 'OpenAI' | 'Anthropic';

/** 上游模型条目：仅保留名 + 尽力获取的上下文长度（token）。 */
export interface ProviderModelEntry {
  name: string;
  contextLength?: number;
}

const TIMEOUT_MS = 10_000;

/**
 * 上下文长度字段白名单（与 agent-api 同口径）：
 * 依次尝试命中，取第一个正整数。上游各家命名不一致，但语义都指向「上下文窗口」。
 *
 * 明确**不取** `max_tokens` / `max_output_tokens`：那是输出上限，混入会污染上下文窗口，
 * 导致请求被错误截断（宁缺毋错）。
 */
export const CONTEXT_LENGTH_FIELDS = [
  'context_length',
  'context_window',
  'max_context_length',
  'max_input_tokens',
  'input_token_limit',
] as const;

/** 读取正整数元数据：只接受 `>= 1` 的整数（字符串/小数/0/负数/NaN 一律忽略）。 */
function readPositiveInt(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined;
}

/** 从上游原始模型条目中按白名单提取上下文长度；取不到返回 `undefined`。 */
export function extractContextLength(raw: unknown): number | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const source = raw as Record<string, unknown>;
  for (const field of CONTEXT_LENGTH_FIELDS) {
    const value = readPositiveInt(source, field);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * 单条上游模型归一：名称读取失败（非字符串/读取抛错）→ 丢弃该条；元数据异常只影响该条自身。
 */
function toProviderModelEntry(raw: unknown): ProviderModelEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  let name: string;
  try {
    const id = (raw as { id?: unknown }).id;
    if (typeof id !== 'string' || id.length === 0) return null;
    name = id;
  } catch {
    return null;
  }
  let contextLength: number | undefined;
  try {
    contextLength = extractContextLength(raw);
  } catch {
    // 单条元数据读取异常（如异常 getter）不得影响其余模型条目
    contextLength = undefined;
  }
  return contextLength === undefined ? { name } : { name, contextLength };
}

export class LLMAPIService {
  async fetchModels(type: ProviderType, endpoint: string, apiKey: string): Promise<string[]> {
    const entries = await this.fetchModelCatalog(type, endpoint, apiKey);
    return entries.map((entry) => entry.name);
  }

  /**
   * 拉取上游模型清单（含尽力获取的上下文长度）。
   * - OpenAI 兼容：逐条白名单字段映射，元数据异常只影响该条；字段缺失即无 `contextLength`；
   * - Anthropic：`contextLength` 恒不提供（SDK 清单不含该信息）；
   * - 结果保持上游顺序（去重由调用方按业务口径处理）。
   */
  async fetchModelCatalog(
    type: ProviderType,
    endpoint: string,
    apiKey: string,
  ): Promise<ProviderModelEntry[]> {
    switch (type) {
      case 'OpenAI':
        return this.fetchOpenAIModelCatalog(endpoint, apiKey);
      case 'Anthropic':
        return this.fetchAnthropicModelCatalog(endpoint, apiKey);
      default:
        throw new Error(`Unsupported provider type: ${type}`);
    }
  }

  private async fetchOpenAIModelCatalog(
    endpoint: string,
    apiKey: string,
  ): Promise<ProviderModelEntry[]> {
    const client = new OpenAI({
      apiKey,
      baseURL: endpoint,
      timeout: TIMEOUT_MS,
    });

    const entries: ProviderModelEntry[] = [];
    for await (const model of client.models.list()) {
      const entry = toProviderModelEntry(model);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  private async fetchAnthropicModelCatalog(
    endpoint: string,
    apiKey: string,
  ): Promise<ProviderModelEntry[]> {
    const client = new Anthropic({
      apiKey,
      baseURL: endpoint,
      timeout: TIMEOUT_MS,
    });

    const entries: ProviderModelEntry[] = [];
    for await (const modelInfo of client.models.list()) {
      try {
        const id = (modelInfo as { id?: unknown }).id;
        if (typeof id !== 'string' || id.length === 0) continue;
        // Anthropic 模型清单不提供上下文元数据：恒不带 contextLength
        entries.push({ name: id });
      } catch {
        // 单条异常隔离
      }
    }
    return entries;
  }
}

export const llmApiService = new LLMAPIService();
