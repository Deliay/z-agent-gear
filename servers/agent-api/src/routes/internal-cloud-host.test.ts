import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';

const h = vi.hoisted(() => ({
  config: { internalApiToken: 'test-internal-token-123456' },
}));

vi.mock('../config/index.js', () => ({ config: h.config }));

vi.mock('../services/cloud-host-service.js', () => ({
  cloudHostService: {
    findRawHost: vi.fn(),
    findRawHostByController: vi.fn(),
    handleReady: vi.fn(),
    handleTerminal: vi.fn(),
  },
}));

vi.mock('../models/controller.js', () => ({
  Controller: { findOne: vi.fn() },
}));

vi.mock('../models/cloud-host.js', () => ({
  CloudHost: { findOne: vi.fn() },
}));

vi.mock('../models/cloud-host-github-binding.js', () => ({
  CloudHostGithubBinding: { findOne: vi.fn() },
}));

vi.mock('../services/github.js', () => ({
  githubService: { createRepoScopedToken: vi.fn() },
}));

vi.mock('../services/key-cache.js', () => ({
  lookupKey: vi.fn(),
}));

vi.mock('../services/commit-settings-service.js', () => ({
  commitSettingsService: { resolveCommitIdentity: vi.fn() },
}));

import { internalCloudHostRouter } from './internal-cloud-host.js';
import { cloudHostService } from '../services/cloud-host-service.js';
import { CloudHost } from '../models/cloud-host.js';
import { CloudHostGithubBinding } from '../models/cloud-host-github-binding.js';
import { githubService } from '../services/github.js';
import { lookupKey } from '../services/key-cache.js';
import { commitSettingsService } from '../services/commit-settings-service.js';

const HOST_ID = '507f1f77bcf86cd799439011';

describe('internal cloud host routes', () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    const app = express();
    app.use(express.json());
    app.use('/internal/cloud-hosts', internalCloudHostRouter);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function post(path: string, token = 'test-internal-token-123456', body?: unknown) {
    return fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  it('rejects missing/invalid internal token', async () => {
    expect((await post(`/internal/cloud-hosts/${HOST_ID}/ready`, 'wrong')).status).toBe(401);
    expect((await post(`/internal/cloud-hosts/${HOST_ID}/ready`, '')).status).toBe(401);
  });

  it('returns 404 for unknown or non-harness hosts', async () => {
    vi.mocked(cloudHostService.findRawHost).mockResolvedValue(null);
    expect((await post(`/internal/cloud-hosts/${HOST_ID}/ready`)).status).toBe(404);

    vi.mocked(cloudHostService.findRawHost).mockResolvedValue({ harnessTypes: [] } as never);
    expect((await post(`/internal/cloud-hosts/${HOST_ID}/ready`)).status).toBe(404);
  });

  it('handles ready callback idempotently', async () => {
    vi.mocked(cloudHostService.findRawHost).mockResolvedValue({
      harnessTypes: ['OPENCODE'],
    } as never);
    vi.mocked(cloudHostService.handleReady).mockResolvedValue({ status: 'RUNNING' } as never);

    const response = await post(`/internal/cloud-hosts/${HOST_ID}/ready`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'RUNNING' });
    expect(cloudHostService.handleReady).toHaveBeenCalledWith(HOST_ID);
  });

  it('validates terminal status', async () => {
    vi.mocked(cloudHostService.findRawHost).mockResolvedValue({
      harnessTypes: ['OPENCODE'],
    } as never);
    const response = await post(`/internal/cloud-hosts/${HOST_ID}/terminal`, undefined, {
      status: 'unknown',
    });
    expect(response.status).toBe(400);
    expect(cloudHostService.handleTerminal).not.toHaveBeenCalled();
  });

  it('forwards terminal status and reason', async () => {
    vi.mocked(cloudHostService.findRawHost).mockResolvedValue({
      harnessTypes: ['OPENCODE'],
    } as never);
    vi.mocked(cloudHostService.handleTerminal).mockResolvedValue({ status: 'FAILED' } as never);

    const response = await post(`/internal/cloud-hosts/${HOST_ID}/terminal`, undefined, {
      status: 'failed',
      reason: 'job failed',
    });
    expect(response.status).toBe(200);
    expect(cloudHostService.handleTerminal).toHaveBeenCalledWith(HOST_ID, {
      status: 'failed',
      reason: 'job failed',
    });
  });

  describe('POST /:controllerId/github-credential', () => {
    const CONTROLLER_ID = '507f1f77bcf86cd799439022';
    const USER_ID = '507f1f77bcf86cd799439023';

    function lean<T>(value: T) {
      return { lean: vi.fn().mockResolvedValue(value) } as never;
    }

    it('T-ICG1: 无凭据 401', async () => {
      const response = await fetch(`${baseUrl}/internal/cloud-hosts/${CONTROLLER_ID}/github-credential`, {
        method: 'POST',
      });
      expect(response.status).toBe(401);
    });

    it('T-ICG2: 服务间 INTERNAL_API_TOKEN + 合法绑定返回 token/expiresAt', async () => {
      vi.mocked(cloudHostService.findRawHostByController).mockResolvedValue({
        userId: USER_ID,
      } as never);
      vi.mocked(CloudHost.findOne).mockReturnValue(
        lean({ status: 'RUNNING' }),
      );
      vi.mocked(CloudHostGithubBinding.findOne).mockReturnValue(
        lean({ accountId: 'acc1', repoFullName: 'owner/repo' }),
      );
      vi.mocked(githubService.createRepoScopedToken).mockResolvedValue({
        token: 'ghs_scoped',
        expiresAt: new Date('2026-10-22T01:00:00.000Z'),
      });

      const response = await post(`/internal/cloud-hosts/${CONTROLLER_ID}/github-credential`);
      const body = (await response.json()) as Record<string, unknown>;
      expect(response.status).toBe(200);
      expect(body).toEqual({
        token: 'ghs_scoped',
        expiresAt: '2026-10-22T01:00:00.000Z',
      });
      expect(githubService.createRepoScopedToken).toHaveBeenCalledWith('acc1', 'owner/repo');
    });

    it('T-ICG4/T-ICG5: controller key 与 controllerId 不匹配 / 非 cloud 403', async () => {
      vi.mocked(lookupKey).mockResolvedValue({
        keyId: 'key1',
        keyHash: 'hash',
        userId: USER_ID,
        status: 'active',
        type: 'cloud',
      });
      const bcrypt = await import('bcryptjs');
      const compare = vi.spyOn(bcrypt.default, 'compare').mockResolvedValue(true as never);

      const controller = await import('../models/controller.js');
      vi.mocked(controller.Controller.findOne).mockReturnValue(
        lean({ _id: 'other-controller' }),
      );
      let response = await post(
        `/internal/cloud-hosts/${CONTROLLER_ID}/github-credential`,
        'zag_k_1_abc',
      );
      expect(response.status).toBe(403);

      vi.mocked(lookupKey).mockResolvedValue({
        keyId: 'key1',
        keyHash: 'hash',
        userId: USER_ID,
        status: 'active',
        type: 'local',
      });
      response = await post(
        `/internal/cloud-hosts/${CONTROLLER_ID}/github-credential`,
        'zag_k_1_abc',
      );
      expect(response.status).toBe(403);
      compare.mockRestore();
    });

    it('T-ICG6: 无绑定 404 NO_BINDING', async () => {
      vi.mocked(cloudHostService.findRawHostByController).mockResolvedValue({
        userId: USER_ID,
      } as never);
      vi.mocked(CloudHost.findOne).mockReturnValue(lean({ status: 'RUNNING' }));
      vi.mocked(CloudHostGithubBinding.findOne).mockReturnValue(lean(null));

      const response = await post(`/internal/cloud-hosts/${CONTROLLER_ID}/github-credential`);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'NO_BINDING' });
    });

    it('T-ICG7: 主机 STOPPED 409', async () => {
      vi.mocked(cloudHostService.findRawHostByController).mockResolvedValue({
        userId: USER_ID,
      } as never);
      vi.mocked(CloudHost.findOne).mockReturnValue(lean({ status: 'STOPPED' }));

      const response = await post(`/internal/cloud-hosts/${CONTROLLER_ID}/github-credential`);
      expect(response.status).toBe(409);
    });

    it('T-ICG8: GitHub 失败 502 且响应不含上游细节', async () => {
      vi.mocked(cloudHostService.findRawHostByController).mockResolvedValue({
        userId: USER_ID,
      } as never);
      vi.mocked(CloudHost.findOne).mockReturnValue(lean({ status: 'RUNNING' }));
      vi.mocked(CloudHostGithubBinding.findOne).mockReturnValue(
        lean({ accountId: 'acc1', repoFullName: 'owner/repo' }),
      );
      vi.mocked(githubService.createRepoScopedToken).mockRejectedValue(
        new Error('failed to issue github token: secret-body'),
      );

      const response = await post(`/internal/cloud-hosts/${CONTROLLER_ID}/github-credential`);
      expect(response.status).toBe(502);
      expect(JSON.stringify(await response.json())).not.toContain('secret-body');
    });
  });

  describe('POST /:controllerId/commit-identity', () => {
    const CONTROLLER_ID = '507f1f77bcf86cd799439032';
    const USER_ID = '507f1f77bcf86cd799439033';

    function lean<T>(value: T) {
      return { lean: vi.fn().mockResolvedValue(value) } as never;
    }

    it('T-IC1: 双鉴权 —— 无凭据 401、错误 Controller key 403、INTERNAL_API_TOKEN 放行', async () => {
      const noAuth = await fetch(
        `${baseUrl}/internal/cloud-hosts/${CONTROLLER_ID}/commit-identity`,
        { method: 'POST' },
      );
      expect(noAuth.status).toBe(401);

      vi.mocked(lookupKey).mockResolvedValue({
        keyId: 'key1',
        keyHash: 'hash',
        userId: USER_ID,
        status: 'active',
        type: 'local',
      });
      const bcrypt = await import('bcryptjs');
      const compare = vi.spyOn(bcrypt.default, 'compare').mockResolvedValue(true as never);
      const forbidden = await post(
        `/internal/cloud-hosts/${CONTROLLER_ID}/commit-identity`,
        'zag_k_1_abc',
      );
      expect(forbidden.status).toBe(403);
      compare.mockRestore();

      vi.mocked(cloudHostService.findRawHostByController).mockResolvedValue({
        userId: USER_ID,
      } as never);
      vi.mocked(commitSettingsService.resolveCommitIdentity).mockResolvedValue({
        mode: 'unset',
      });
      const allowed = await post(`/internal/cloud-hosts/${CONTROLLER_ID}/commit-identity`);
      expect(allowed.status).toBe(200);
    });

    it('T-IC2: 正常返回 co_author 全字段', async () => {
      vi.mocked(cloudHostService.findRawHostByController).mockResolvedValue({
        userId: USER_ID,
      } as never);
      vi.mocked(commitSettingsService.resolveCommitIdentity).mockResolvedValue({
        mode: 'co_author',
        name: 'octocat',
        email: '777+octocat@users.noreply.github.com',
        coAuthorName: 'zag-bot[bot]',
        coAuthorEmail: '123456+zag-bot[bot]@users.noreply.github.com',
      });

      const response = await post(`/internal/cloud-hosts/${CONTROLLER_ID}/commit-identity`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        mode: 'co_author',
        name: 'octocat',
        email: '777+octocat@users.noreply.github.com',
        coAuthorName: 'zag-bot[bot]',
        coAuthorEmail: '123456+zag-bot[bot]@users.noreply.github.com',
      });
      expect(commitSettingsService.resolveCommitIdentity).toHaveBeenCalledWith(CONTROLLER_ID);
    });

    it('T-IC3: 主机不存在（服务间 token 鉴权路径）仍 200 unset，永不 404', async () => {
      vi.mocked(cloudHostService.findRawHostByController).mockResolvedValue(null);
      vi.mocked(commitSettingsService.resolveCommitIdentity).mockResolvedValue({
        mode: 'unset',
      });

      const response = await post(`/internal/cloud-hosts/${CONTROLLER_ID}/commit-identity`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ mode: 'unset' });
    });

    it('T-IC3: 解析抛错也按 unset 兜底', async () => {
      vi.mocked(cloudHostService.findRawHostByController).mockResolvedValue({
        userId: USER_ID,
      } as never);
      vi.mocked(commitSettingsService.resolveCommitIdentity).mockRejectedValue(
        new Error('db down'),
      );

      const response = await post(`/internal/cloud-hosts/${CONTROLLER_ID}/commit-identity`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ mode: 'unset' });
    });

    it('T-IC4: unset 响应不含 null 字段（裁决 4）', async () => {
      vi.mocked(cloudHostService.findRawHostByController).mockResolvedValue({
        userId: USER_ID,
      } as never);
      vi.mocked(commitSettingsService.resolveCommitIdentity).mockResolvedValue({
        mode: 'unset',
      });

      const response = await post(`/internal/cloud-hosts/${CONTROLLER_ID}/commit-identity`);
      expect(Object.keys((await response.json()) as Record<string, unknown>)).toEqual(['mode']);
    });
  });
});
