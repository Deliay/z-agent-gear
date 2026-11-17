import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock('../observability/logger.js', () => ({
  logger: { child: () => ({ warn }) },
}));

import { config } from '../config/index.js';
import { notifyModelConfigChanged } from './model-push-notifier.js';

describe('notifyModelConfigChanged (T-NOTIFY1)', () => {
  const originalAgentApiUrl = config.agentApiUrl;
  const originalInternalApiToken = config.internalApiToken;

  beforeEach(() => {
    vi.clearAllMocks();
    config.agentApiUrl = 'http://agent-api.internal:4001';
    config.internalApiToken = 'internal-token';
  });

  afterEach(() => {
    config.agentApiUrl = originalAgentApiUrl;
    config.internalApiToken = originalInternalApiToken;
    vi.unstubAllGlobals();
  });

  it('warns and returns without any request when AGENT_API_URL is missing', async () => {
    config.agentApiUrl = '';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(notifyModelConfigChanged()).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatchObject({ hasAgentApiUrl: false, hasInternalApiToken: true });
    expect(warn.mock.calls[0][1]).toContain('not configured');
  });

  it('warns and returns without any request when INTERNAL_API_TOKEN is missing', async () => {
    config.internalApiToken = '';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(notifyModelConfigChanged()).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatchObject({ hasAgentApiUrl: true, hasInternalApiToken: false });
  });

  it('POSTs the global refresh endpoint with a Bearer token and scope=global body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    vi.stubGlobal('fetch', fetchMock);

    await expect(notifyModelConfigChanged()).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://agent-api.internal:4001/internal/model-config/refresh');
    expect(options.method).toBe('POST');
    expect(options.headers).toMatchObject({
      'Content-Type': 'application/json',
      Authorization: 'Bearer internal-token',
    });
    expect(JSON.parse(String(options.body))).toEqual({ scope: 'global' });
    // 5s 超时：以 AbortSignal 表达
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(warn).not.toHaveBeenCalled();
  });

  it('swallows non-2xx responses and only warns', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal('fetch', fetchMock);

    await expect(notifyModelConfigChanged()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatchObject({ status: 500 });
  });

  it('swallows timeout / network errors and only warns', async () => {
    const timeoutError = new Error('The operation was aborted due to timeout');
    const fetchMock = vi.fn().mockRejectedValue(timeoutError);
    vi.stubGlobal('fetch', fetchMock);

    await expect(notifyModelConfigChanged()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatchObject({ err: timeoutError });
    expect(warn.mock.calls[0][1]).toBe('model config refresh failed');
  });
});
