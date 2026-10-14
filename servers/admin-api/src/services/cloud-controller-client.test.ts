import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CloudControllerClient,
  ControlPlaneUnavailableError,
  CONTROL_PLANE_UNAVAILABLE,
  mapCloudContainer,
} from './cloud-controller-client';

const OPTS = { baseUrl: 'http://cloud-controller:4003', token: 'internal-secret', timeoutMs: 5000 };

function jsonResponse(body: unknown, status = 200, statusText = 'OK'): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { 'Content-Type': 'application/json' },
  });
}

function authHeader(init: RequestInit | undefined): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.Authorization;
}

describe('CloudControllerClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('list', () => {
    it('calls the internal API with the bearer token and maps lowercase enums to GraphQL enums', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse([
          {
            id: 'c1',
            name: 'zag-worker-abc123',
            status: 'online',
            purpose: 'idle',
            refId: null,
            createdAt: '2026-10-14T00:00:00.000Z',
            connectedAt: '2026-10-14T00:01:00.000Z',
            exitedAt: null,
            exitReason: null,
          },
        ]),
      );

      const client = new CloudControllerClient(OPTS);
      const result = await client.list();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://cloud-controller:4003/internal/containers');
      expect(authHeader(init)).toBe('Bearer internal-secret');
      expect(init.signal).toBeInstanceOf(AbortSignal);

      expect(result).toEqual([
        {
          id: 'c1',
          name: 'zag-worker-abc123',
          status: 'ONLINE',
          purpose: 'IDLE',
          refId: null,
          createdAt: '2026-10-14T00:00:00.000Z',
          connectedAt: '2026-10-14T00:01:00.000Z',
          exitedAt: null,
          exitReason: null,
        },
      ]);
    });

    it('throws CONTROL_PLANE_UNAVAILABLE when cloud-controller is unreachable', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));
      const client = new CloudControllerClient(OPTS);

      await expect(client.list()).rejects.toBeInstanceOf(ControlPlaneUnavailableError);
      await expect(client.list()).rejects.toMatchObject({ code: CONTROL_PLANE_UNAVAILABLE });
    });

    it('throws CONTROL_PLANE_UNAVAILABLE when the token is not configured', async () => {
      const client = new CloudControllerClient({ baseUrl: 'http://cloud-controller:4003', token: '' });
      await expect(client.list()).rejects.toMatchObject({ code: CONTROL_PLANE_UNAVAILABLE });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('surfaces non-2xx responses instead of degrading', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ error: 'unauthorized' }, 401, 'Unauthorized'));
      const client = new CloudControllerClient(OPTS);
      await expect(client.list()).rejects.toThrow('cloud-controller list failed: 401');
    });
  });

  describe('start', () => {
    it('POSTs the lowercase purpose and maps the created container', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(
          {
            id: 'c2',
            name: 'zag-worker-xyz',
            status: 'creating',
            purpose: 'idle',
            refId: null,
            createdAt: '2026-10-14T00:00:00.000Z',
            connectedAt: null,
            exitedAt: null,
            exitReason: null,
          },
          201,
          'Created',
        ),
      );

      const client = new CloudControllerClient(OPTS);
      const created = await client.start('IDLE');

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://cloud-controller:4003/internal/containers');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({ purpose: 'idle' });
      expect(created.status).toBe('CREATING');
      expect(created.purpose).toBe('IDLE');
    });

    it('maps ADMIN_TASK to the hyphenated internal purpose', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ id: 'c3', name: 'n', status: 'creating', purpose: 'admin-task', createdAt: 'x' }, 201, 'Created'),
      );
      const client = new CloudControllerClient(OPTS);
      await client.start('ADMIN_TASK');
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(init.body as string)).toEqual({ purpose: 'admin-task' });
    });

    it('propagates the internal error message on a non-2xx response', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ error: '该任务类型暂未开放' }, 400, 'Bad Request'));
      const client = new CloudControllerClient(OPTS);
      await expect(client.start('WORKFLOW')).rejects.toThrow('该任务类型暂未开放');
    });

    it('throws CONTROL_PLANE_UNAVAILABLE when unreachable', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));
      const client = new CloudControllerClient(OPTS);
      await expect(client.start('IDLE')).rejects.toMatchObject({ code: CONTROL_PLANE_UNAVAILABLE });
    });
  });

  describe('destroy', () => {
    it('DELETEs the container and returns true on success', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ success: true }));
      const client = new CloudControllerClient(OPTS);
      const result = await client.destroy('c1');

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://cloud-controller:4003/internal/containers/c1');
      expect(init.method).toBe('DELETE');
      expect(result).toBe(true);
    });

    it('returns false when the container does not exist (404)', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ error: 'not found' }, 404, 'Not Found'));
      const client = new CloudControllerClient(OPTS);
      await expect(client.destroy('missing')).resolves.toBe(false);
    });

    it('throws CONTROL_PLANE_UNAVAILABLE when unreachable', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));
      const client = new CloudControllerClient(OPTS);
      await expect(client.destroy('c1')).rejects.toMatchObject({ code: CONTROL_PLANE_UNAVAILABLE });
    });
  });

  describe('mapCloudContainer', () => {
    it('maps a stored Mongo document (Date timestamps + _id)', () => {
      const mapped = mapCloudContainer({
        _id: { toString: () => 'c9' },
        name: 'zag-worker-old',
        status: 'failed',
        purpose: 'admin-task',
        refId: 'task-1',
        createdAt: new Date('2026-10-13T00:00:00.000Z'),
        connectedAt: null,
        exitedAt: new Date('2026-10-13T00:05:00.000Z'),
        exitReason: '回连超时',
      });

      expect(mapped).toEqual({
        id: 'c9',
        name: 'zag-worker-old',
        status: 'FAILED',
        purpose: 'ADMIN_TASK',
        refId: 'task-1',
        createdAt: '2026-10-13T00:00:00.000Z',
        connectedAt: null,
        exitedAt: '2026-10-13T00:05:00.000Z',
        exitReason: '回连超时',
      });
    });
  });
});
