import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  openaiModels: vi.fn(),
  anthropicModels: vi.fn(),
}));

vi.mock('openai', () => ({
  default: class OpenAI {
    models = { list: h.openaiModels };
  },
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class Anthropic {
    models = { list: h.anthropicModels };
  },
}));

import { LLMAPIService } from './llm-api.js';

const service = new LLMAPIService();

async function* iterableOf(items: unknown[]) {
  for (const item of items) {
    yield item;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('fetchModelCatalog (T-CAT1)', () => {
  it('maps every whitelisted context-length field one by one', async () => {
    h.openaiModels.mockReturnValue(
      iterableOf([
        { id: 'a', context_length: 128000 },
        { id: 'b', context_window: 64000 },
        { id: 'c', max_context_length: 32000 },
        { id: 'd', max_input_tokens: 16000 },
        { id: 'e', input_token_limit: 8000 },
      ]),
    );

    await expect(service.fetchModelCatalog('OpenAI', 'https://api.example.com/v1', 'sk-x')).resolves.toEqual([
      { name: 'a', contextLength: 128000 },
      { name: 'b', contextLength: 64000 },
      { name: 'c', contextLength: 32000 },
      { name: 'd', contextLength: 16000 },
      { name: 'e', contextLength: 8000 },
    ]);
  });

  it('prefers context_length when several fields are present', async () => {
    h.openaiModels.mockReturnValue(
      iterableOf([{ id: 'a', context_window: 64000, context_length: 128000 }]),
    );

    await expect(
      service.fetchModelCatalog('OpenAI', 'https://api.example.com/v1', 'sk-x'),
    ).resolves.toEqual([{ name: 'a', contextLength: 128000 }]);
  });

  it('never takes output limits (max_tokens / max_output_tokens)', async () => {
    h.openaiModels.mockReturnValue(
      iterableOf([
        { id: 'a', max_tokens: 4096 },
        { id: 'b', max_output_tokens: 8192 },
        { id: 'c', max_tokens: 4096, max_output_tokens: 8192 },
      ]),
    );

    await expect(
      service.fetchModelCatalog('OpenAI', 'https://api.example.com/v1', 'sk-x'),
    ).resolves.toEqual([{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
  });

  it('ignores non-positive-integer values (0 / negative / float / string)', async () => {
    h.openaiModels.mockReturnValue(
      iterableOf([
        { id: 'zero', context_length: 0 },
        { id: 'negative', context_length: -1 },
        { id: 'float', context_length: 1.5 },
        { id: 'string', context_length: '128000' },
        { id: 'nan', context_length: Number.NaN },
      ]),
    );

    await expect(
      service.fetchModelCatalog('OpenAI', 'https://api.example.com/v1', 'sk-x'),
    ).resolves.toEqual([
      { name: 'zero' },
      { name: 'negative' },
      { name: 'float' },
      { name: 'string' },
      { name: 'nan' },
    ]);
  });

  it('falls back to a later whitelisted field when the first is invalid', async () => {
    h.openaiModels.mockReturnValue(
      iterableOf([{ id: 'a', context_length: 0, context_window: 64000 }]),
    );

    await expect(
      service.fetchModelCatalog('OpenAI', 'https://api.example.com/v1', 'sk-x'),
    ).resolves.toEqual([{ name: 'a', contextLength: 64000 }]);
  });

  it('never exposes contextLength for Anthropic', async () => {
    h.anthropicModels.mockReturnValue(
      iterableOf([
        { id: 'claude-a', context_length: 200000 },
        { id: 'claude-b' },
      ]),
    );

    await expect(
      service.fetchModelCatalog('Anthropic', 'https://api.anthropic.com', 'sk-ant'),
    ).resolves.toEqual([{ name: 'claude-a' }, { name: 'claude-b' }]);
  });

  it('isolates a broken entry without dropping the others', async () => {
    const broken = {
      id: 'broken',
      // 元数据 getter 抛错：只影响该条目本身
      get context_length(): number {
        throw new Error('metadata exploded');
      },
    };
    h.openaiModels.mockReturnValue(
      iterableOf([{ id: 'before', context_length: 1000 }, broken, { id: 'after', context_length: 2000 }]),
    );

    await expect(
      service.fetchModelCatalog('OpenAI', 'https://api.example.com/v1', 'sk-x'),
    ).resolves.toEqual([
      { name: 'before', contextLength: 1000 },
      { name: 'broken' },
      { name: 'after', contextLength: 2000 },
    ]);
  });

  it('rejects unsupported provider types with the original message', async () => {
    await expect(
      service.fetchModelCatalog('Gemini' as never, 'https://api.example.com', 'sk-x'),
    ).rejects.toThrow('Unsupported provider type: Gemini');
  });
});

describe('fetchModels compatibility', () => {
  it('returns the plain string[] in upstream order', async () => {
    h.openaiModels.mockReturnValue(
      iterableOf([
        { id: 'a', context_length: 128000 },
        { id: 'b' },
        { id: 'c', context_window: 64000 },
      ]),
    );

    const models = await service.fetchModels('OpenAI', 'https://api.example.com/v1', 'sk-x');

    expect(models).toEqual(['a', 'b', 'c']);
    expect(models.every((name) => typeof name === 'string')).toBe(true);
  });
});
