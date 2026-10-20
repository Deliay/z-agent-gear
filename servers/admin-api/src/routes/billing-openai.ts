import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config/index.js';
import { BillingApiCall } from '../models/billing-api-call.js';
import { Model } from '../models/model.js';
import { Provider } from '../models/provider.js';
import { billingKeyAuth, openAiError, type BillingRequest } from '../middleware/billing-key-auth.js';
import { creditCheckService } from '../services/billing/credit-check.js';
import { decrypt } from '../services/crypto.js';
import { tokenCostCents } from '../services/billing/money.js';
import type { BillingEventMessage } from '../services/billing/mq/publisher.js';

interface PublisherLike {
  enqueue(event: BillingEventMessage): Promise<void>;
}

export interface BillingOpenAiRouterDeps {
  publisher: PublisherLike;
  logger?: { warn?: (...args: unknown[]) => void };
}

export interface ModelPricingCents {
  inputPerMillion: number;
  cachedInputPerMillion: number;
  outputPerMillion: number;
  isBillable: boolean;
}

interface Usage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

const RATE_LIMIT_PER_MINUTE = 60;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function allowRequest(keyId: string): boolean {
  const now = Date.now();
  // C5：定期清理过期桶，避免 Map 无限增长。
  if (rateBuckets.size > 10_000) {
    for (const [key, value] of rateBuckets) {
      if (value.resetAt <= now) rateBuckets.delete(key);
    }
  }
  const bucket = rateBuckets.get(keyId);
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(keyId, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (bucket.count >= RATE_LIMIT_PER_MINUTE) return false;
  bucket.count += 1;
  return true;
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          const record = part as Record<string, unknown>;
          if (typeof record.text === 'string') return record.text;
        }
        return '';
      })
      .join('');
  }
  return '';
}

/** 缺失用量兜底用的文本估算（保持历史口径，仅用于 output 兜底）。 */
function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * R10-1：**预检**输入估算必须构成实际费用的上界。
 *
 * 采用 UTF-8 字节数 / 可配置倍率（默认 1 token/字节）：
 * - 每个 token 至少消费 1 字节，因此字节数不会低于真实 token 数；
 * - CJK 每字 3 字节，天然覆盖「1 字 ≈ 1 token」甚至更差的 tokenizer；
 * - 倍率只允许调大（降低保守程度），默认不得低于 1。
 */
export function estimatePromptTextTokens(text: string): number {
  if (!text) return 0;
  const divisor = Math.max(1, config.modelTokenEstimateBytesPerToken);
  return Math.max(1, Math.ceil(Buffer.byteLength(text, 'utf8') / divisor));
}

function conservativeJsonTokens(value: unknown, minimum = 0): number {
  if (value === undefined || value === null) return minimum;
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? '';
  } catch {
    serialized = String(value);
  }
  return Math.max(minimum, estimatePromptTextTokens(serialized));
}

/**
 * 单条消息 content 的保守 token 上界。R10-1：
 * - 文本按 UTF-8 字节估算；
 * - image / audio / file 等非文本块按固定高估系数（≥ 数千 token）；
 * - tool/function 参数与结果既计固定开销也计入序列化字节。
 */
export function estimateContentTokens(content: unknown): number {
  if (typeof content === 'string') return estimatePromptTextTokens(content);
  if (Array.isArray(content)) {
    return content.reduce<number>((total, part) => total + estimateContentTokens(part), 0);
  }
  if (!content || typeof content !== 'object') return 0;

  const record = content as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : '';
  if (type === 'text' || typeof record.text === 'string') {
    return estimatePromptTextTokens(String(record.text ?? ''));
  }
  if (type === 'image_url' || type === 'image') {
    return config.modelEstimateImageTokens;
  }
  if (type === 'input_audio' || type === 'audio') {
    return config.modelEstimateAudioTokens;
  }
  if (type === 'file' || type === 'document') {
    return config.modelEstimateFileTokens;
  }
  if (type === 'tool_result' || type === 'tool_use' || type === 'function') {
    return (
      config.modelEstimateToolTokens +
      estimateContentTokens(record.content) +
      conservativeJsonTokens(record.input ?? record.arguments)
    );
  }
  // 未知非文本块：按工具开销 + 序列化字节高估，绝不返回 0。
  return Math.max(config.modelEstimateToolTokens, conservativeJsonTokens(record));
}

/**
 * R10-1：整轮请求（messages + tools + tool_calls）的保守 token 上界。
 * 作为 `creditCheck` 的同步预检额度，保证「估算 ≥ 实际」。
 */
export function estimateRequestTokens(
  messages: unknown[],
  tools?: unknown,
): number {
  let total = 0;
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const record = message as Record<string, unknown>;
    // role/分隔符等结构开销。
    total += 4;
    total += estimateContentTokens(record.content);
    if (record.tool_calls !== undefined) {
      total += conservativeJsonTokens(record.tool_calls, config.modelEstimateToolTokens);
    }
    if (record.function_call !== undefined) {
      total += conservativeJsonTokens(record.function_call, config.modelEstimateToolTokens);
    }
    if (typeof record.name === 'string') total += estimatePromptTextTokens(record.name);
  }
  if (tools !== undefined) {
    total += conservativeJsonTokens(tools, config.modelEstimateToolTokens);
  }
  return Math.max(1, total);
}

export interface UsageFallbackInput {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/**
 * 建议 15：缺失用量兜底。**逐段**补全，避免「input 有值、output=0 但已产生文本」被少计：
 * - 两段都为 0：input 用请求 prompt、output 用已产生文本估算（无文本则用请求上限）；
 * - 仅 output=0 且已有文本：按文本估算 output；
 * - 仅 input=0：用请求 prompt。
 * 返回 `estimated` 表示是否发生估算（调用方据此标记账单）。
 */
export function resolveUsageFallback(
  usage: UsageFallbackInput,
  promptTokens: number,
  maxOutputTokens: number,
  outputText: string,
  estimatedTokens: boolean,
): { usage: UsageFallbackInput; estimated: boolean } {
  let estimated = estimatedTokens;
  if (usage.inputTokens + usage.outputTokens === 0) {
    estimated = true;
    usage.inputTokens = promptTokens || 1;
    usage.outputTokens = estimateTokens(outputText) || maxOutputTokens;
  } else if (usage.outputTokens === 0 && outputText.length > 0) {
    estimated = true;
    usage.outputTokens = estimateTokens(outputText);
  }
  if (usage.inputTokens === 0) {
    estimated = true;
    usage.inputTokens = promptTokens || 1;
  }
  return { usage, estimated };
}

function pricingFromModel(pricing: unknown): ModelPricingCents | null {
  if (!pricing || typeof pricing !== 'object') return null;
  const p = pricing as Record<string, unknown>;
  return {
    inputPerMillion: Number(p.inputPerMillion ?? 0),
    cachedInputPerMillion: Number(p.cachedInputPerMillion ?? 0),
    outputPerMillion: Number(p.outputPerMillion ?? 0),
    isBillable: p.isBillable !== false,
  };
}

function isPricingComplete(pricing: ModelPricingCents): boolean {
  return (
    pricing.inputPerMillion > 0 ||
    pricing.cachedInputPerMillion > 0 ||
    pricing.outputPerMillion > 0
  );
}

/**
 * R10-1：预检费用上界。输入按 `max(input, cachedInput)` 单价计算，避免缓存单价更高时低估；
 * 输出受 `max_tokens` 硬上限约束，直接按上限计价。
 */
export function estimateCost(
  pricing: ModelPricingCents,
  promptTokens: number,
  maxOutputTokens: number,
): number {
  const maxInputRate = Math.max(pricing.inputPerMillion, pricing.cachedInputPerMillion);
  return (
    tokenCostCents(promptTokens, maxInputRate) +
    tokenCostCents(maxOutputTokens, pricing.outputPerMillion)
  );
}

function toApiError(
  res: Response,
  status: number,
  type: string,
  code: string,
  message: string,
): void {
  openAiError(res, status, { type, code, message });
}

/** OpenAI 兼容计费网关：Key 鉴权 → 预扣费检查 → 转发 → 用量事件（outbox）。 */
export function createBillingOpenAiRouter(deps: BillingOpenAiRouterDeps): Router {
  const router = Router();
  const logger = deps.logger ?? console;

  router.get('/models', billingKeyAuth, async (req: Request, res: Response) => {
    const billing = (req as BillingRequest).billing!;
    // C5：契约声明 /v1/models 也受限流约束（429）。
    if (!allowRequest(billing.id)) {
      toApiError(res, 429, 'rate_limit_exceeded', 'rate_limit_exceeded', '请求过于频繁，请稍后重试');
      return;
    }
    const models = await Model.find({ scope: 'global', isEnabled: true }).lean();
    const data = models
      .filter((model) => {
        const pricing = pricingFromModel(model.pricing);
        return pricing && pricing.isBillable && isPricingComplete(pricing);
      })
      .map((model) => ({
        id: model.name,
        object: 'model',
        owned_by: 'agent-gear',
        created: Math.floor(
          new Date((model as unknown as { createdAt?: Date }).createdAt ?? Date.now()).getTime() / 1000,
        ),
      }));
    res.json({ object: 'list', data });
  });

  router.post('/chat/completions', billingKeyAuth, async (req: Request, res: Response) => {
    const billing = (req as BillingRequest).billing!;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const modelName = typeof body.model === 'string' ? body.model : '';
    const messages = Array.isArray(body.messages) ? body.messages : null;
    // R10-14：严格校验请求体，避免 `stream:"true"` 字符串走非流分支、空 messages 打到上游。
    if (body.stream !== undefined && typeof body.stream !== 'boolean') {
      toApiError(res, 400, 'invalid_request_error', 'invalid_request', 'stream 必须为布尔值');
      return;
    }
    if (
      body.max_tokens !== undefined &&
      (!Number.isInteger(body.max_tokens) || Number(body.max_tokens) < 1)
    ) {
      toApiError(res, 400, 'invalid_request_error', 'invalid_request', 'max_tokens 必须为正整数');
      return;
    }
    if (!modelName || !messages || messages.length === 0) {
      toApiError(res, 400, 'invalid_request_error', 'invalid_request', 'model 与 messages 为必填项');
      return;
    }

    const model = await Model.findOne({ scope: 'global', name: modelName, isEnabled: true });
    if (!model) {
      toApiError(res, 404, 'invalid_request_error', 'model_not_found', `模型不存在: ${modelName}`);
      return;
    }
    const provider = await Provider.findById(model.providerId);
    if (!provider || !provider.isEnabled) {
      toApiError(res, 404, 'invalid_request_error', 'model_not_found', `模型供应商不可用: ${modelName}`);
      return;
    }
    const pricing = pricingFromModel(model.pricing);
    if (!pricing) {
      toApiError(
        res,
        400,
        'invalid_request_error',
        'model_not_priced',
        '模型尚未配置定价，请联系管理员补全',
      );
      return;
    }
    const billable = pricing.isBillable;
    if (billable && !isPricingComplete(pricing)) {
      toApiError(
        res,
        400,
        'invalid_request_error',
        'model_not_priced',
        '模型定价不完整，请联系管理员补全',
      );
      return;
    }

    if (!allowRequest(billing.id)) {
      toApiError(res, 429, 'rate_limit_exceeded', 'rate_limit_exceeded', '请求过于频繁，请稍后重试');
      return;
    }

    const requestId = crypto.randomUUID();
    // R10-1：预检使用 messages/tools 全量保守估算（含多模态、CJK、工具参数），不再只取文本 len/4。
    const promptTokens = estimateRequestTokens(messages, body.tools);
    const maxOutputTokens = Math.max(
      1,
      Number(body.max_tokens ?? config.modelDefaultMaxOutputTokens) ||
        config.modelDefaultMaxOutputTokens,
    );
    // PRD §3.5：账户被冻结时拒绝新的模型调用（不区分是否计费模型）。
    // 未开启计费的模型不参与余额预检，但冻结闸门同样适用（余额检查仍仅对 billable 执行）。
    if (!billable) {
      const statusCheck = await creditCheckService.check({
        accountId: billing.accountId,
        estimatedCredits: 0,
        policy: 'reject-on-insufficient',
        ref: { type: 'model_call', id: requestId },
      });
      if (!statusCheck.allowed && statusCheck.reason === 'ACCOUNT_FROZEN') {
        toApiError(res, 402, 'account_frozen', 'account_frozen', '账户已冻结，请联系管理员处理');
        return;
      }
      if (!statusCheck.allowed && statusCheck.reason === 'NOT_FOUND') {
        // C6：非计费模型同样不得「忽略 NOT_FOUND」而放行到不存在的账户。
        toApiError(res, 402, 'account_not_found', 'account_not_found', '计费账户不存在，请联系管理员');
        return;
      }
    }
    if (billable) {
      const estimate = Math.max(1, estimateCost(pricing, promptTokens, maxOutputTokens));
      const check = await creditCheckService.check({
        accountId: billing.accountId,
        estimatedCredits: estimate,
        policy: 'reject-on-insufficient',
        // 与异步扣费 ref 口径一致（requestId），保证预检凭证可回溯同一调用
        ref: { type: 'model_call', id: requestId },
      });
      if (!check.allowed) {
        const reason = check.reason;
        if (reason === 'ACCOUNT_FROZEN') {
          toApiError(res, 402, 'account_frozen', 'account_frozen', '账户已冻结，请联系管理员处理');
        } else if (reason === 'NOT_FOUND') {
          // C6：账户缺失不得误报为「余额不足」。
          toApiError(res, 402, 'account_not_found', 'account_not_found', '计费账户不存在，请联系管理员');
        } else {
          toApiError(res, 402, 'insufficient_quota', 'insufficient_quota', '余额不足，请联系管理员充值');
        }
        return;
      }
    }

    const startedAt = new Date();
    await BillingApiCall.create({
      requestId,
      accountId: billing.accountId,
      apiKeyId: billing.id,
      modelId: String(model._id),
      modelName: model.name,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      cost: 0,
      status: 'started',
      estimated: false,
      startedAt,
    });

    const stream = body.stream === true;
    const usage: Usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
    let outputText = '';
    let finalized = false;
    let aborted = false;
    let abortReason = '';
    let estimatedTokens = false;

    const finalize = async (status: 'completed' | 'aborted'): Promise<void> => {
      if (finalized) return;
      finalized = true;
      const resolved = resolveUsageFallback(usage, promptTokens, maxOutputTokens, outputText, estimatedTokens);
      const estimated = resolved.estimated;
      estimatedTokens = estimated;
      const cost = billable
        ? tokenCostCents(Math.max(0, usage.inputTokens - usage.cachedInputTokens), pricing.inputPerMillion) +
          tokenCostCents(usage.cachedInputTokens, pricing.cachedInputPerMillion) +
          tokenCostCents(usage.outputTokens, pricing.outputPerMillion)
        : 0;
      // R3：finalize 只负责「落事实」，绝不抛出——落库失败不得被外层 catch 当成 upstream_error
      // 而把正常完成的调用翻转为 aborted、换 eventType 重投双事实。此处原地重试 + 告警。
      const writeFinalize = async (): Promise<void> => {
        if (billable) {
          await deps.publisher.enqueue({
            eventId: `model_call.${status === 'aborted' ? 'aborted' : 'completed'}:${requestId}`,
            eventType: status === 'aborted' ? 'model_call.aborted' : 'model_call.completed',
            occurredAt: new Date().toISOString(),
            accountId: billing.accountId,
            resourceId: requestId,
            payload: {
              modelId: String(model._id),
              inputTokens: usage.inputTokens,
              cachedInputTokens: usage.cachedInputTokens,
              outputTokens: usage.outputTokens,
              estimated,
              estimatedInputTokens: usage.inputTokens,
              estimatedOutputTokens: usage.outputTokens,
              ...(status === 'aborted' ? { reason: abortReason || 'client_aborted' } : {}),
            },
          });
        }
        await BillingApiCall.updateOne(
          { requestId },
          {
            $set: {
              inputTokens: usage.inputTokens,
              cachedInputTokens: usage.cachedInputTokens,
              outputTokens: usage.outputTokens,
              cost,
              status: status === 'aborted' ? 'aborted' : 'completed',
              estimated,
              finishedAt: new Date(),
            },
          },
        );
      };
      try {
        await writeFinalize();
      } catch (err) {
        logger.warn?.(`[billing-gateway] finalize failed (retrying): ${(err as Error).message}`);
        try {
          await writeFinalize();
        } catch (retryErr) {
          // 不翻转状态、不换 eventType 重投；仅告警，由对账/重放兜底。
          logger.warn?.(
            `[billing-gateway] finalize retry failed for ${requestId}: ${(retryErr as Error).message}`,
          );
          // P3-④：落账彻底失败的兜底——best-effort 标记 `failed`（区别于 completed/aborted），
          // 避免记录永久停留 `started`；该尝试失败则放弃（对账可见）。
          await BillingApiCall.updateOne(
            { requestId },
            { $set: { status: 'failed', finishedAt: new Date() } },
          ).catch(() => undefined);
        }
      }
    };

    let apiKey: string;
    try {
      apiKey = decrypt(provider.encryptedCredential);
    } catch (err) {
      // C2：供应商凭据解密失败只记服务端日志，对外固定文案，避免内部错误信息泄漏。
      logger.warn?.(`[billing-gateway] provider credential error: ${(err as Error).message}`);
      toApiError(res, 500, 'server_error', 'provider_credential_error', '模型服务配置异常，请联系管理员');
      return;
    }

    const abortController = new AbortController();
    // C1：Node 16+ 的 `req.on('close')` 在请求消息完成时即触发（非连接断开），会误判/漏判；
    // 正确检测客户端中断应为 `res.on('close')` 且响应尚未写完（`!res.writableEnded`）。
    res.on('close', () => {
      if (res.writableEnded) return;
      aborted = true;
      abortReason = 'client_aborted';
      abortController.abort();
    });
    // R6：注册监听前的若干 DB 往返窗口内若已断开，`close` 事件不会重放，这里以 `res.destroyed` 兜底。
    if (res.destroyed) {
      aborted = true;
      abortReason = 'client_aborted';
      abortController.abort();
    }

    const basePayload = {
      ...body,
      model: model.name,
      // R10-1：预检按 `maxOutputTokens` 计价，必须把它变成上游的硬上限；
      // 缺省时注入默认值，避免上游按自身默认生成更长的输出击穿上界。
      ...(body.max_tokens === undefined ? { max_tokens: maxOutputTokens } : {}),
      ...(stream ? { stream_options: { include_usage: true } } : {}),
    };
    delete (basePayload as Record<string, unknown>).stream_options;

    try {
      if (provider.type === 'Anthropic') {
        const result = await forwardAnthropic({
          provider: provider as unknown as { endpoint: string },
          apiKey,
          modelName: model.name,
          messages,
          maxOutputTokens,
          stream,
          signal: abortController.signal,
          res,
          usage,
          onText: (text) => {
            outputText += text;
          },
        });
        if (!stream) {
          // R10-8：与 OpenAI 路径同标准，客户端中断后不得再写已销毁的响应。
          if (!aborted && !res.writableEnded) res.json(result);
        }
        await finalize(aborted ? 'aborted' : 'completed');
        return;
      }

      const client = new OpenAI({
        apiKey,
        baseURL: provider.endpoint,
        timeout: 300_000,
      });
      if (!stream) {
        const completion = (await client.chat.completions.create(basePayload as never, {
          signal: abortController.signal,
        })) as unknown as {
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            prompt_tokens_details?: { cached_tokens?: number };
          };
          choices?: Array<{ message?: { content?: string } }>;
        };
        usage.inputTokens = Number(completion.usage?.prompt_tokens ?? 0);
        usage.cachedInputTokens = Number(completion.usage?.prompt_tokens_details?.cached_tokens ?? 0);
        usage.outputTokens = Number(completion.usage?.completion_tokens ?? 0);
        outputText = completion.choices?.[0]?.message?.content ?? '';
        if (!aborted && !res.writableEnded) res.json(completion);
        await finalize(aborted ? 'aborted' : 'completed');
        return;
      }

      // SSE 流式：透传 chunk，采集 usage 与文本
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();

      const streamPayload = { ...basePayload, stream: true, stream_options: { include_usage: true } };
      const completionStream = (await client.chat.completions.create(streamPayload as never, {
        signal: abortController.signal,
      })) as unknown as AsyncIterable<Record<string, unknown>>;

      for await (const chunk of completionStream) {
        const chunkUsage = chunk.usage as
          | {
              prompt_tokens?: number;
              completion_tokens?: number;
              prompt_tokens_details?: { cached_tokens?: number };
            }
          | undefined;
        if (chunkUsage) {
          usage.inputTokens = Number(chunkUsage.prompt_tokens ?? usage.inputTokens);
          usage.cachedInputTokens = Number(
            chunkUsage.prompt_tokens_details?.cached_tokens ?? usage.cachedInputTokens,
          );
          usage.outputTokens = Number(chunkUsage.completion_tokens ?? usage.outputTokens);
        }
        const choices = chunk.choices as
          | Array<{ delta?: { content?: string } }>
          | undefined;
        const delta = choices?.[0]?.delta?.content;
        if (typeof delta === 'string') outputText += delta;
        if (!aborted) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      if (!aborted) {
        res.write('data: [DONE]\n\n');
        res.end();
      }
      await finalize(aborted ? 'aborted' : 'completed');
    } catch (err) {
      if (aborted) {
        await finalize('aborted');
        if (!res.writableEnded) res.end();
        return;
      }
      logger.warn?.(`[billing-gateway] upstream call failed: ${(err as Error).message}`);
      // 上游报错/超时同样按「中断」计费并标注，不得伪装成 completed
      aborted = true;
      abortReason = 'upstream_error';
      estimatedTokens = true;
      await finalize('aborted');
      if (!res.headersSent) {
        toApiError(res, 502, 'server_error', 'upstream_error', '模型服务暂时不可用');
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });

  return router;
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/**
 * R10-9：Anthropic 的 `input_tokens` **不含**缓存 token，而本管线统一按 OpenAI 语义
 * （`prompt_tokens` 包含 cached）处理。这里把缓存读写回加到 input，保证 `cached ⊆ input`，
 * 避免未来支持 prompt caching 后系统性少计费。
 */
export function applyAnthropicUsage(target: Usage, usage?: AnthropicUsage): void {
  if (!usage) return;
  const cacheRead = Number(usage.cache_read_input_tokens ?? 0);
  const cacheCreation = Number(usage.cache_creation_input_tokens ?? 0);
  const uncachedInput = Number(usage.input_tokens ?? 0);
  target.inputTokens = uncachedInput + cacheRead + cacheCreation;
  target.cachedInputTokens = cacheRead;
  if (usage.output_tokens !== undefined) {
    target.outputTokens = Number(usage.output_tokens ?? 0);
  }
}

/** Anthropic 形状转换：OpenAI messages → Anthropic messages，响应/流式 → OpenAI 形状。 */
async function forwardAnthropic(input: {
  provider: { endpoint: string };
  apiKey: string;
  modelName: string;
  messages: unknown[];
  maxOutputTokens: number;
  stream: boolean;
  signal: AbortSignal;
  res: Response;
  usage: Usage;
  onText: (text: string) => void;
}): Promise<unknown> {
  const client = new Anthropic({ apiKey: input.apiKey, baseURL: input.provider.endpoint });
  const system = input.messages
    .filter((message) => (message as { role?: string }).role === 'system')
    .map((message) => contentText((message as { content?: unknown }).content))
    .join('\n');
  const messages = input.messages
    .filter((message) => (message as { role?: string }).role !== 'system')
    .map((message) => {
      const role = (message as { role?: string }).role;
      return {
        role: role === 'assistant' ? ('assistant' as const) : ('user' as const),
        content: contentText((message as { content?: unknown }).content),
      };
    });

  const request = {
    model: input.modelName,
    max_tokens: input.maxOutputTokens,
    messages,
    ...(system ? { system } : {}),
  };

  const id = `chatcmpl-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);

  if (!input.stream) {
    const response = (await client.messages.create(request as never, {
      signal: input.signal,
    })) as unknown as {
      content?: Array<{ type: string; text?: string }>;
      stop_reason?: string;
      usage?: AnthropicUsage;
    };
    const text = (response.content ?? [])
      .filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .join('');
    applyAnthropicUsage(input.usage, response.usage);
    input.onText(text);
    return {
      id,
      object: 'chat.completion',
      created,
      model: input.modelName,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: text },
          finish_reason: response.stop_reason ?? 'stop',
        },
      ],
      usage: {
        prompt_tokens: input.usage.inputTokens,
        completion_tokens: input.usage.outputTokens,
        total_tokens: input.usage.inputTokens + input.usage.outputTokens,
        prompt_tokens_details: { cached_tokens: input.usage.cachedInputTokens },
      },
    };
  }

  input.res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  input.res.setHeader('Cache-Control', 'no-cache, no-transform');
  input.res.setHeader('Connection', 'keep-alive');
  input.res.flushHeaders?.();

  const stream = (await client.messages.create({ ...request, stream: true } as never, {
    signal: input.signal,
  })) as unknown as AsyncIterable<Record<string, unknown>>;

  for await (const event of stream) {
    const type = event.type as string;
    if (type === 'message_start') {
      const message = event.message as { usage?: AnthropicUsage } | undefined;
      applyAnthropicUsage(input.usage, message?.usage);
    } else if (type === 'content_block_delta') {
      const delta = event.delta as { text?: string } | undefined;
      if (delta?.text) {
        input.onText(delta.text);
        // R10-8：客户端中断后不再写已销毁的响应（与 OpenAI 流式路径一致）。
        if (!input.signal.aborted && !input.res.writableEnded) {
          input.res.write(
            `data: ${JSON.stringify({
              id,
              object: 'chat.completion.chunk',
              created,
              model: input.modelName,
              choices: [{ index: 0, delta: { content: delta.text } }],
            })}\n\n`,
          );
        }
      }
    } else if (type === 'message_delta') {
      const deltaUsage = event.usage as { output_tokens?: number } | undefined;
      input.usage.outputTokens = Number(deltaUsage?.output_tokens ?? input.usage.outputTokens);
    }
  }
  if (!input.signal.aborted && !input.res.writableEnded) {
    input.res.write(
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model: input.modelName,
        choices: [],
        usage: {
          prompt_tokens: input.usage.inputTokens,
          completion_tokens: input.usage.outputTokens,
          total_tokens: input.usage.inputTokens + input.usage.outputTokens,
        },
      })}\n\n`,
    );
    input.res.write('data: [DONE]\n\n');
    input.res.end();
  }
  return null;
}
