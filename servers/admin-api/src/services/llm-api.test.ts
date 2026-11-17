import { describe, it, expect, vi, beforeEach } from 'vitest';

const { state } = vi.hoisted(() => ({
  state: {
    openai: [] as unknown[],
    anthropic: [] as unknown[],
  },
}));

vi.mock('openai', () => ({
  default: class {
    models = {
      list: async function* () {
        for (const item of state.openai) yield item;
      },
    };
  },
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    models = {
      list: async function* () {
        for (const item of state.anthropic) yield item;
      },
    };
  },
}));

import { llmApiService, ProviderType } from './llm-api';

describe('LLMAPIService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.openai = [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }];
    state.anthropic = [{ id: 'claude-3-5-sonnet' }];
  });

  it('fetches OpenAI models through the SDK', async () => {
    await expect(
      llmApiService.fetchModels('OpenAI', 'https://api.openai.com/v1', 'key'),
    ).resolves.toEqual(['gpt-4o', 'gpt-4o-mini']);
  });

  it('fetches Anthropic models through the SDK', async () => {
    await expect(
      llmApiService.fetchModels('Anthropic', 'https://api.anthropic.com', 'key'),
    ).resolves.toEqual(['claude-3-5-sonnet']);
  });

  it('throws for unsupported provider types', async () => {
    await expect(
      llmApiService.fetchModels('Bedrock' as ProviderType, 'https://example.com', 'key'),
    ).rejects.toThrow('Unsupported provider type');
  });

  describe('T-UMC6: fetchModelCatalog 与 agent-api 同口径', () => {
    const catalog = (): ReturnType<typeof llmApiService.fetchModelCatalog> =>
      llmApiService.fetchModelCatalog('OpenAI', 'https://api.openai.com/v1', 'key');

    it.each(['context_length', 'context_window', 'max_context_length', 'max_input_tokens', 'input_token_limit'])(
      'maps whitelisted %s to contextLength',
      async (field) => {
        state.openai = [{ id: 'model-a', [field]: 200_000 }];
        await expect(catalog()).resolves.toEqual([{ name: 'model-a', contextLength: 200_000 }]);
      },
    );

    it('uses the whitelist precedence (context_length first)', async () => {
      state.openai = [
        { id: 'model-a', context_length: 128_000, context_window: 200_000, max_input_tokens: 64_000 },
      ];
      await expect(catalog()).resolves.toEqual([{ name: 'model-a', contextLength: 128_000 }]);
    });

    it('never takes output limits (max_tokens / max_output_tokens)', async () => {
      state.openai = [
        { id: 'model-a', max_tokens: 8192 },
        { id: 'model-b', max_output_tokens: 4096 },
      ];
      await expect(catalog()).resolves.toEqual([{ name: 'model-a' }, { name: 'model-b' }]);
    });

    it('ignores non-positive-integer / string metadata', async () => {
      state.openai = [
        { id: 'zero', context_length: 0 },
        { id: 'negative', context_length: -1 },
        { id: 'float', context_length: 128_000.5 },
        { id: 'string', context_length: '200000' },
        { id: 'nan', context_length: Number.NaN },
      ];
      await expect(catalog()).resolves.toEqual([
        { name: 'zero' },
        { name: 'negative' },
        { name: 'float' },
        { name: 'string' },
        { name: 'nan' },
      ]);
    });

    it('keeps upstream order and always omits contextLength for Anthropic', async () => {
      state.anthropic = [
        { id: 'claude-a', context_length: 200_000 },
        { id: 'claude-b' },
      ];
      await expect(
        llmApiService.fetchModelCatalog('Anthropic', 'https://api.anthropic.com', 'key'),
      ).resolves.toEqual([{ name: 'claude-a' }, { name: 'claude-b' }]);
    });

    it('isolates a single-entry metadata read failure', async () => {
      const brokenMetadata = { id: 'broken-meta' } as Record<string, unknown>;
      Object.defineProperty(brokenMetadata, 'context_length', {
        get() {
          throw new Error('metadata read failure');
        },
        enumerable: true,
      });
      state.openai = [{ id: 'model-a', context_length: 100_000 }, brokenMetadata, { id: 'model-c' }];

      await expect(catalog()).resolves.toEqual([
        { name: 'model-a', contextLength: 100_000 },
        { name: 'broken-meta' },
        { name: 'model-c' },
      ]);
    });

    it('skips entries whose name cannot be read, without affecting the rest', async () => {
      const brokenId = { id: 'broken-id' } as Record<string, unknown>;
      Object.defineProperty(brokenId, 'id', {
        get() {
          throw new Error('id read failure');
        },
        enumerable: true,
      });
      state.openai = [{ id: 'model-a' }, brokenId, { id: 'model-c' }];

      await expect(catalog()).resolves.toEqual([{ name: 'model-a' }, { name: 'model-c' }]);
    });

    it('fetchModels stays a string[] derived from the catalog, order unchanged', async () => {
      state.openai = [
        { id: 'model-a', context_length: 100_000 },
        { id: 'model-b' },
      ];
      const names = await llmApiService.fetchModels('OpenAI', 'https://api.openai.com/v1', 'key');
      expect(names).toEqual(['model-a', 'model-b']);
      expect(names.every((name) => typeof name === 'string')).toBe(true);
    });
  });
});
