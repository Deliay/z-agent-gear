import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

export type ProviderType = 'OpenAI' | 'Anthropic';

/** 上游模型清单条目（`contextLength` 为尽力获取，取不到为 undefined）。 */
export interface ProviderModelEntry {
  name: string;
  contextLength?: number;
}

const TIMEOUT_MS = 10_000;

/**
 * 上下文长度字段白名单（顺序即优先级，命中即取）。
 *
 * 只收「上下文窗口」语义字段：`max_tokens` / `max_output_tokens` 是**输出上限**，
 * 混入会污染上下文长度导致请求被错误截断（D15）。
 */
const CONTEXT_LENGTH_FIELDS = [
  'context_length',
  'context_window',
  'max_context_length',
  'max_input_tokens',
  'input_token_limit',
] as const;

/** 仅正整数（0/负数/小数/字符串/NaN → 未提供）。 */
function toPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** 读取单条模型 id；元数据异常返回 null（只影响该条目，T-CAT1）。 */
function readModelId(model: unknown): string | null {
  try {
    if (!model || typeof model !== 'object') return null;
    const id = (model as { id?: unknown }).id;
    return typeof id === 'string' && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/** OpenAI 兼容条目的上下文长度：逐字段白名单探测，命中即取正整数。 */
function readOpenAIContextLength(model: unknown): number | undefined {
  if (!model || typeof model !== 'object') return undefined;
  const record = model as Record<string, unknown>;
  for (const field of CONTEXT_LENGTH_FIELDS) {
    try {
      const value = toPositiveInteger(record[field]);
      if (value !== undefined) return value;
    } catch {
      // 单条/单字段读取异常不影响其余字段与条目
    }
  }
  return undefined;
}

export class LLMAPIService {
  /**
   * 上游模型清单（含尽力获取的上下文长度）。
   * - OpenAI 兼容：逐条白名单字段映射，单条元数据异常只影响该条目；
   * - Anthropic：`models.list()` 无上下文元数据，恒 undefined。
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

  /** 兼容既有调用点：仅模型名，顺序不变（D15）。 */
  async fetchModels(type: ProviderType, endpoint: string, apiKey: string): Promise<string[]> {
    const entries = await this.fetchModelCatalog(type, endpoint, apiKey);
    return entries.map((entry) => entry.name);
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
      try {
        const name = readModelId(model);
        if (!name) continue;
        const contextLength = readOpenAIContextLength(model);
        entries.push(contextLength === undefined ? { name } : { name, contextLength });
      } catch {
        // 单条元数据异常（getter 抛错等）不影响其余条目
      }
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
      const name = readModelId(modelInfo);
      if (!name) continue;
      entries.push({ name });
    }
    return entries;
  }
}

export const llmApiService = new LLMAPIService();
