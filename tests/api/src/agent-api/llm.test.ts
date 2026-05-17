import { describe, it, expect } from 'vitest';

const API_URL = process.env.API_URL || 'http://localhost:4000/graphql';

function gqlRequest(query: string, variables?: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return fetch(API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  });
}

let authToken = '';
let providerId = '';

const SIGNUP = `
  mutation Signup($username: String!, $password: String!) {
    signup(username: $username, password: $password) {
      token
      user { id username }
    }
  }
`;

const PROVIDERS_QUERY = `
  query Providers {
    providers {
      id name type endpoint credentialType credentialValue isEnabled
      models { id name isEnabled sortOrder }
      createdAt updatedAt
    }
  }
`;

const MODELS_QUERY = `
  query Models {
    models {
      id providerId provider { id name type isEnabled }
      name isCustom isEnabled sortOrder createdAt updatedAt
    }
  }
`;

const MODELS_BY_PROVIDER = `
  query ModelsByProvider($providerId: ID!) {
    modelsByProvider(providerId: $providerId) {
      id name isCustom isEnabled sortOrder
    }
  }
`;

const CREATE_PROVIDER = `
  mutation CreateProvider($input: ProviderInput!) {
    createProvider(input: $input) {
      id name type endpoint credentialType credentialValue isEnabled
      models { id name isEnabled sortOrder }
      createdAt updatedAt
    }
  }
`;

const UPDATE_PROVIDER = `
  mutation UpdateProvider($id: ID!, $input: ProviderInput!) {
    updateProvider(id: $id, input: $input) {
      id name type isEnabled
    }
  }
`;

const DELETE_PROVIDER = `
  mutation DeleteProvider($id: ID!) {
    deleteProvider(id: $id)
  }
`;

const TOGGLE_PROVIDER = `
  mutation ToggleProvider($id: ID!) {
    toggleProvider(id: $id) {
      id isEnabled
      models { id isEnabled }
    }
  }
`;

const BATCH_ENABLE = `
  mutation BatchEnableProviders($ids: [ID!]!) {
    batchEnableProviders(ids: $ids) { successCount }
  }
`;

const BATCH_DISABLE = `
  mutation BatchDisableProviders($ids: [ID!]!) {
    batchDisableProviders(ids: $ids) { successCount }
  }
`;

const BATCH_DELETE = `
  mutation BatchDeleteProviders($ids: [ID!]!) {
    batchDeleteProviders(ids: $ids) { successCount }
  }
`;

const CREATE_CUSTOM_MODEL = `
  mutation CreateCustomModel($input: CustomModelInput!) {
    createCustomModel(input: $input) {
      id providerId name isCustom isEnabled sortOrder
    }
  }
`;

const TOGGLE_MODEL = `
  mutation ToggleModel($id: ID!) {
    toggleModel(id: $id) { id isEnabled }
  }
`;

const UPDATE_MODEL_SORT = `
  mutation UpdateModelSortOrder($ids: [ID!]!) {
    updateModelSortOrder(ids: $ids) { id sortOrder }
  }
`;

describe('LLM Provider & Model API', () => {
  beforeAll(async () => {
    const uid = `llm_${Date.now()}`;
    const res = await gqlRequest(SIGNUP, { username: uid, password: 'testpass123' });
    const body = await res.json();
    authToken = body.data?.signup?.token ?? '';
    expect(authToken).toBeDefined();
  });

  describe('queries without auth', () => {
    it('should reject providers query without token', async () => {
      const res = await gqlRequest(PROVIDERS_QUERY);
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });

    it('should reject models query without token', async () => {
      const res = await gqlRequest(MODELS_QUERY);
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });
  });

  describe('queries with auth', () => {
    it('should return empty providers list', async () => {
      const res = await gqlRequest(PROVIDERS_QUERY, undefined, authToken);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.providers).toEqual([]);
    });

    it('should return empty models list', async () => {
      const res = await gqlRequest(MODELS_QUERY, undefined, authToken);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.models).toEqual([]);
    });
  });

  describe('createProvider', () => {
    it('should reject invalid endpoint (connectivity test fails)', async () => {
      const res = await gqlRequest(
        CREATE_PROVIDER,
        {
          input: {
            name: `test-provider-${Date.now()}`,
            type: 'OpenAI',
            endpoint: 'https://invalid-endpoint.example.com/v1',
            credentialType: 'api_key',
            credentialValue: 'sk-test-fake-key',
          },
        },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBeTruthy();
      const providersRes = await gqlRequest(PROVIDERS_QUERY, undefined, authToken);
      const providersBody = await providersRes.json();
      expect(providersBody.data.providers).toEqual([]);
    });

    it('should reject empty name', async () => {
      const res = await gqlRequest(
        CREATE_PROVIDER,
        {
          input: {
            name: '',
            type: 'OpenAI',
            endpoint: 'https://api.openai.com/v1',
            credentialType: 'api_key',
            credentialValue: 'sk-test-key',
          },
        },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeDefined();
    });

    it('should reject mutation without auth', async () => {
      const res = await gqlRequest(CREATE_PROVIDER, {
        input: {
          name: 'no-auth',
          type: 'OpenAI',
          endpoint: 'https://api.openai.com/v1',
          credentialType: 'api_key',
          credentialValue: 'sk-key',
        },
      });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });
  });

  describe('batch operations without existing providers', () => {
    it('should handle batchEnable on empty list', async () => {
      const res = await gqlRequest(BATCH_ENABLE, { ids: [] }, authToken);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.batchEnableProviders.successCount).toBe(0);
    });

    it('should handle batchDisable on empty list', async () => {
      const res = await gqlRequest(BATCH_DISABLE, { ids: [] }, authToken);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.batchDisableProviders.successCount).toBe(0);
    });

    it('should handle batchDelete on empty list', async () => {
      const res = await gqlRequest(BATCH_DELETE, { ids: [] }, authToken);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.batchDeleteProviders.successCount).toBe(0);
    });

    it('should reject batch operations without auth', async () => {
      const res = await gqlRequest(BATCH_ENABLE, { ids: ['fake-id'] });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });
  });

  describe('toggleProvider', () => {
    it('should reject toggling non-existent provider', async () => {
      const res = await gqlRequest(TOGGLE_PROVIDER, { id: '000000000000000000000000' }, authToken);
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Provider not found');
    });

    it('should reject toggle without auth', async () => {
      const res = await gqlRequest(TOGGLE_PROVIDER, { id: 'fake-id' });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });
  });

  describe('deleteProvider', () => {
    it('should return false for non-existent provider', async () => {
      const res = await gqlRequest(DELETE_PROVIDER, { id: '000000000000000000000000' }, authToken);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.deleteProvider).toBe(false);
    });
  });

  describe('updateProvider', () => {
    it('should reject updating non-existent provider', async () => {
      const res = await gqlRequest(
        UPDATE_PROVIDER,
        {
          id: '000000000000000000000000',
          input: {
            name: 'updated',
            type: 'OpenAI',
            endpoint: 'https://invalid-update-endpoint.example.com/v1',
            credentialType: 'api_key',
            credentialValue: 'sk-updated-key',
          },
        },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBeTruthy();
    });
  });

  describe('custom model mutations', () => {
    it('should reject createCustomModel without auth', async () => {
      const res = await gqlRequest(CREATE_CUSTOM_MODEL, {
        input: { providerId: 'fake', name: 'test-model' },
      });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });

    it('should reject toggleModel without auth', async () => {
      const res = await gqlRequest(TOGGLE_MODEL, { id: 'fake' });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });

    it('should reject updateModelSortOrder without auth', async () => {
      const res = await gqlRequest(UPDATE_MODEL_SORT, { ids: ['fake1', 'fake2'] });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });
  });
});
