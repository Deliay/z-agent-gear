import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

export type ProviderType = 'OpenAI' | 'Anthropic';

const TIMEOUT_MS = 10_000;

export class LLMAPIService {
  async fetchModels(type: ProviderType, endpoint: string, apiKey: string): Promise<string[]> {
    switch (type) {
      case 'OpenAI':
        return this.fetchOpenAIModels(endpoint, apiKey);
      case 'Anthropic':
        return this.fetchAnthropicModels(endpoint, apiKey);
      default:
        throw new Error(`Unsupported provider type: ${type}`);
    }
  }

  private async fetchOpenAIModels(endpoint: string, apiKey: string): Promise<string[]> {
    const client = new OpenAI({
      apiKey,
      baseURL: endpoint,
      timeout: TIMEOUT_MS,
    });

    const models: string[] = [];
    for await (const model of client.models.list()) {
      models.push(model.id);
    }
    return models;
  }

  private async fetchAnthropicModels(endpoint: string, apiKey: string): Promise<string[]> {
    const client = new Anthropic({
      apiKey,
      baseURL: endpoint,
      timeout: TIMEOUT_MS,
    });

    const models: string[] = [];
    for await (const modelInfo of client.models.list()) {
      models.push(modelInfo.id);
    }
    return models;
  }
}

export const llmApiService = new LLMAPIService();
