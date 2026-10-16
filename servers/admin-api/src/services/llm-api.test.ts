import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('openai', () => ({
  default: class {
    models = {
      list: async function* () {
        yield { id: 'gpt-4o' };
        yield { id: 'gpt-4o-mini' };
      },
    };
  },
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    models = {
      list: async function* () {
        yield { id: 'claude-3-5-sonnet' };
      },
    };
  },
}));

import { llmApiService, ProviderType } from './llm-api';

describe('LLMAPIService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
