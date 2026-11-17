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
        modelProviders: '{"providers":[]}',
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

  it('pushes harness models to the container and normalizes the ack result', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ delivered: true, appliedTypes: ['opencode', 'deepseek_harness'] }),
    });
    const client = new CloudControllerClient('http://cc', 'token');
    const provision = {
      providers: [{ vendorId: 'zag', displayName: 'Agent Gear', models: [{ id: 'a' }] }],
    };

    await expect(client.pushHarnessModels('c 1', provision)).resolves.toEqual({
      delivered: true,
      appliedTypes: ['opencode', 'deepseek_harness'],
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://cc/internal/containers/c%201/harness-models');
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ provision });
  });

  it('returns delivered:false with reason instead of throwing', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ delivered: false, reason: 'ack_timeout' }),
    });
    const client = new CloudControllerClient('http://cc', 'token');
    await expect(
      client.pushHarnessModels('c1', { providers: [] }),
    ).resolves.toEqual({ delivered: false, reason: 'ack_timeout' });
  });

  it('maps non-2xx to CloudControllerRequestError with status/code', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ error: 'CONTAINER_NOT_ONLINE' }),
    });
    const client = new CloudControllerClient('http://cc', 'token');
    await expect(
      client.pushHarnessModels('c1', { providers: [] }),
    ).rejects.toMatchObject({ status: 409, code: 'CONTAINER_NOT_ONLINE' });
  });
});
