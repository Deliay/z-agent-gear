import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { redisMock, configMock } = vi.hoisted(() => ({
  redisMock: {
    get: vi.fn(),
    set: vi.fn(),
  },
  configMock: {
    agentGearRegistryUrl: 'https://registry.test/agent-gear',
    agentGearVersionRefreshIntervalMs: 600_000,
    agentGearAutoUpdateIntervalMinutes: 10,
  },
}));

vi.mock('../middleware/redis.js', () => ({
  getRedisClient: vi.fn(() => redisMock),
}));

vi.mock('../config/index.js', () => ({ config: configMock }));

import {
  AGENT_GEAR_LATEST_VERSION_KEY,
  fetchLatestAgentGearVersion,
  getLatestAgentGearVersion,
  normalizeAgentGearVersion,
  parseLatestVersionFromRegistry,
  resetAgentGearVersionStateForTest,
  startAgentGearVersionRefresh,
  stopAgentGearVersionRefresh,
} from './agent-gear-version.js';

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return {
    ok: (init.status ?? 200) >= 200 && (init.status ?? 200) < 300,
    status: init.status ?? 200,
    json: async () => body,
  } as unknown as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  redisMock.get.mockReset();
  redisMock.set.mockReset().mockResolvedValue('OK');
  configMock.agentGearRegistryUrl = 'https://registry.test/agent-gear';
  configMock.agentGearVersionRefreshIntervalMs = 600_000;
  resetAgentGearVersionStateForTest();
});

afterEach(() => {
  resetAgentGearVersionStateForTest();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('agent-gear-version', () => {
  it('T-AGV1: 抓取成功解析 dist-tags.latest 并写 Redis {version, fetchedAt}；读取命中直接返回', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ 'dist-tags': { latest: '2.20.0' } }));
    redisMock.get.mockResolvedValueOnce(null);

    await expect(getLatestAgentGearVersion()).resolves.toBe('2.20.0');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(redisMock.set).toHaveBeenCalledTimes(1);
    const [key, raw] = redisMock.set.mock.calls[0] as [string, string];
    expect(key).toBe(AGENT_GEAR_LATEST_VERSION_KEY);
    const stored = JSON.parse(raw) as { version: string; fetchedAt: string };
    expect(stored.version).toBe('2.20.0');
    expect(Number.isNaN(Date.parse(stored.fetchedAt))).toBe(false);

    // 命中缓存：不再抓取
    redisMock.get.mockResolvedValueOnce(JSON.stringify({ version: '2.20.0', fetchedAt: 'x' }));
    await expect(getLatestAgentGearVersion()).resolves.toBe('2.20.0');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('T-AGV2: 抓取失败保留旧值并 WARN（非 2xx/超时/非法 JSON/缺字段/非法版本）', async () => {
    const old = JSON.stringify({ version: '2.19.0', fetchedAt: 'old' });
    const failureModes: Array<() => void> = [
      () => fetchMock.mockResolvedValue(jsonResponse({}, { status: 503 })),
      () => fetchMock.mockRejectedValue(new Error('aborted')),
      () => fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => { throw new Error('bad'); } } as unknown as Response),
      () => fetchMock.mockResolvedValue(jsonResponse({ 'dist-tags': {} })),
      () => fetchMock.mockResolvedValue(jsonResponse({ 'dist-tags': { latest: '2.20.0\n' } })),
      () => fetchMock.mockResolvedValue(jsonResponse({ 'dist-tags': { latest: 'x'.repeat(65) } })),
    ];

    for (const mode of failureModes) {
      mode();
      redisMock.get.mockResolvedValueOnce(old);
      await expect(getLatestAgentGearVersion()).resolves.toBe('2.19.0');
      expect(redisMock.set).toHaveBeenCalledTimes(0);
    }

    // 无旧值时失败 → null
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 500 }));
    redisMock.get.mockResolvedValueOnce(null);
    await expect(getLatestAgentGearVersion()).resolves.toBeNull();
  });

  it('T-AGV3: Redis miss → 查询路径 single-flight 恰好一次抓取（并发 10 个调用）', async () => {
    let resolveFetch: ((value: Response) => void) | undefined;
    fetchMock.mockImplementation(
      () => new Promise<Response>((resolve) => { resolveFetch = resolve; }),
    );
    redisMock.get.mockResolvedValue(null);

    const pending = Array.from({ length: 10 }, () => getLatestAgentGearVersion());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveFetch?.(jsonResponse({ 'dist-tags': { latest: '2.20.0' } }));
    await expect(Promise.all(pending)).resolves.toEqual(Array(10).fill('2.20.0'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(redisMock.set).toHaveBeenCalledTimes(1);
  });

  it('T-AGV4: 抓取也失败 → null；Redis 读写异常降级不抛', async () => {
    redisMock.get.mockRejectedValue(new Error('redis down'));
    fetchMock.mockRejectedValue(new Error('network down'));
    await expect(getLatestAgentGearVersion()).resolves.toBeNull();

    redisMock.get.mockResolvedValue(null);
    fetchMock.mockResolvedValue(jsonResponse({ 'dist-tags': { latest: '2.20.0' } }));
    redisMock.set.mockRejectedValue(new Error('redis write down'));
    await expect(fetchLatestAgentGearVersion()).resolves.toBe('2.20.0');
  });

  it('T-AGV5: 调度器启动即抓一次；interval 周期触发；0 关闭周期；timer unref', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(jsonResponse({ 'dist-tags': { latest: '2.20.0' } }));
    redisMock.get.mockResolvedValue(null);

    const unref = vi.fn();
    const realSetInterval = globalThis.setInterval;
    const intervalSpy = vi
      .spyOn(globalThis, 'setInterval')
      .mockImplementation(((fn: () => void, ms?: number) => {
        const timer = realSetInterval(fn, ms) as NodeJS.Timeout;
        timer.unref = unref;
        return timer;
      }) as typeof setInterval);

    startAgentGearVersionRefresh(1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(unref).toHaveBeenCalled();

    stopAgentGearVersionRefresh();
    intervalSpy.mockRestore();

    // interval=0：仅启动一次，无定时器
    fetchMock.mockClear();
    vi.useFakeTimers();
    startAgentGearVersionRefresh(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    stopAgentGearVersionRefresh();
  });

  it('T-AGV6: 版本串校验（去控制字符/空白/超长）与 registry 解析', () => {
    expect(normalizeAgentGearVersion(' 2.20.0 ')).toBe('2.20.0');
    expect(normalizeAgentGearVersion('2.20\u0000.0')).toBe('2.20.0');
    expect(normalizeAgentGearVersion('')).toBeNull();
    expect(normalizeAgentGearVersion('\u0001')).toBeNull();
    expect(normalizeAgentGearVersion('x'.repeat(65))).toBeNull();
    expect(normalizeAgentGearVersion(2.2)).toBeNull();
    expect(parseLatestVersionFromRegistry({ 'dist-tags': { latest: '2.20.0' } })).toBe('2.20.0');
    expect(parseLatestVersionFromRegistry({})).toBeNull();
    expect(parseLatestVersionFromRegistry(null)).toBeNull();
  });
});
