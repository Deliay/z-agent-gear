import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CloudControllerClient,
  CloudControllerUnavailableError,
} from './cloud-controller-client.js';

describe('CloudControllerClient', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends harness start request with bearer token', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'container-1', status: 'creating' }),
    });
    const client = new CloudControllerClient('http://cc:10004', 'internal-token');
    const result = await client.startHarness({
      hostId: 'host-1',
      controllerKeyId: 'key-1',
      containerApiKeyId: 'model-key-1',
      userId: 'user-1',
      tenantId: 'user-1',
      hostName: 'my-cloud',
      harnessTypes: ['opencode'],
      expiresAt: new Date('2026-10-22T00:00:00.000Z'),
      billingAccountId: 'account-1',
      agentGearMinVersion: '2.5.0',
      workloadPlan: [{ workloadId: 'preset-1', params: {}, implicit: false, required: true }],
      secrets: {
        hostEndpoint: 'wss://host',
        hostKey: 'zag_k_1_x',
        modelApiKey: 'zag_sk_x',
        modelBaseUrl: 'http://admin-api/v1',
        modelIds: '["a"]',
        modelContextLengths: '{"a":128000}',
        defaultWorkspace: '/home/worker/workspace',
      },
    });

    expect(result).toEqual({ id: 'container-1', status: 'creating' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://cc:10004/internal/containers');
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer internal-token',
    });
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.purpose).toBe('harness');
    expect(body.hostId).toBe('host-1');
    expect(body.workloadPlan[0].required).toBe(true);
    expect(body.secrets.hostKey).toBe('zag_k_1_x');
  });

  it('maps network/HTTP failures to control plane unavailable', async () => {
    const client = new CloudControllerClient('http://cc', 'token');
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(client.destroyContainer('c1')).rejects.toBeInstanceOf(
      CloudControllerUnavailableError,
    );

    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    await expect(client.listContainers()).rejects.toBeInstanceOf(
      CloudControllerUnavailableError,
    );
  });

  it('rejects missing configuration without calling fetch', async () => {
    const client = new CloudControllerClient('', '');
    await expect(client.listContainers()).rejects.toBeInstanceOf(
      CloudControllerUnavailableError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('filters container list by hostId/userId', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => [] });
    const client = new CloudControllerClient('http://cc', 'token');
    await client.listContainers({ hostId: 'h1', userId: 'u1' });
    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://cc/internal/containers?hostId=h1&userId=u1',
    );
  });
});
