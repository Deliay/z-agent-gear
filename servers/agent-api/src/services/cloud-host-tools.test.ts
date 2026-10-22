import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../models/session.js', () => ({
  Session: { findOne: vi.fn() },
}));
vi.mock('../models/controller.js', () => ({
  Controller: { findOne: vi.fn() },
}));
vi.mock('../models/cloud-host.js', () => ({
  CloudHost: { findOne: vi.fn() },
}));
vi.mock('../models/mcp-server.js', () => ({
  McpServer: { findOneAndUpdate: vi.fn(), findOne: vi.fn() },
}));

import { Session } from '../models/session.js';
import { Controller } from '../models/controller.js';
import { CloudHost } from '../models/cloud-host.js';
import {
  handleCloudHostToolRequest,
  CLOUD_HOST_TOOLS_SERVER_NAME,
} from './cloud-host-tools.js';

const SESSION_ID = '507f1f77bcf86cd799439011';
const USER_ID = '507f1f77bcf86cd799439012';
const CONTROLLER_ID = '507f1f77bcf86cd799439013';

function lean<T>(value: T) {
  return { lean: vi.fn().mockResolvedValue(value) } as never;
}

function makeService(overrides: Record<string, unknown> = {}) {
  return {
    list: vi.fn().mockResolvedValue([
      { workloadId: 'w1', name: 'Github', installed: false },
    ]),
    createInstallOperation: vi.fn().mockResolvedValue({ id: 'op1' }),
    waitForCompletion: vi.fn().mockResolvedValue({ id: 'op1', status: 'SUCCEEDED' }),
    ...overrides,
  } as any;
}

describe('cloud-host-tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('T-CHM1: tools/list 返回 2 个工具', async () => {
    const result = await handleCloudHostToolRequest(
      { userId: USER_ID, sessionId: SESSION_ID },
      { method: 'tools/list' },
      makeService(),
    );
    const tools = (result.result as any).tools;
    expect(tools.map((tool: any) => tool.name)).toEqual([
      'workload_list',
      'workload_install',
    ]);
    expect((await handleCloudHostToolRequest({ userId: USER_ID, sessionId: SESSION_ID }, { method: 'initialize' }, makeService())).result).toMatchObject({
      serverInfo: { name: CLOUD_HOST_TOOLS_SERVER_NAME },
    });
  });

  it('T-CHM2: 非云会话返回 UNAVAILABLE', async () => {
    vi.mocked(Session.findOne).mockReturnValue(
      lean({ _id: SESSION_ID, controllerId: CONTROLLER_ID }),
    );
    vi.mocked(Controller.findOne).mockReturnValue(lean({ _id: CONTROLLER_ID, type: 'local' }));

    const result = await handleCloudHostToolRequest(
      { userId: USER_ID, sessionId: SESSION_ID },
      { method: 'tools/call', params: { name: 'workload_list', arguments: {} } },
      makeService(),
    );
    expect(result.error).toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('T-CHM3: workload_list 复用 service.list', async () => {
    vi.mocked(Session.findOne).mockReturnValue(
      lean({ _id: SESSION_ID, controllerId: CONTROLLER_ID }),
    );
    vi.mocked(Controller.findOne).mockReturnValue(lean({ _id: CONTROLLER_ID, type: 'cloud' }));
    vi.mocked(CloudHost.findOne).mockReturnValue(
      lean({ _id: 'host1', controllerId: CONTROLLER_ID }),
    );
    const service = makeService();

    const result = await handleCloudHostToolRequest(
      { userId: USER_ID, sessionId: SESSION_ID },
      { method: 'tools/call', params: { name: 'workload_list', arguments: {} } },
      service,
    );
    expect(service.list).toHaveBeenCalledWith(USER_ID, CONTROLLER_ID);
    expect((result.result as any).content[0].text).toContain('Github');
  });

  it('T-CHM-L1: workload_list 含 Aspire/Docker/.NET 与 workloadKind/installed', async () => {
    vi.mocked(Session.findOne).mockReturnValue(
      lean({ _id: SESSION_ID, controllerId: CONTROLLER_ID }),
    );
    vi.mocked(Controller.findOne).mockReturnValue(lean({ _id: CONTROLLER_ID, type: 'cloud' }));
    vi.mocked(CloudHost.findOne).mockReturnValue(
      lean({ _id: 'host1', controllerId: CONTROLLER_ID }),
    );
    const service = makeService({
      list: vi.fn().mockResolvedValue([
        { workloadId: 'docker', name: 'Docker', workloadKind: 'STANDARD', installed: true },
        { workloadId: 'dotnet', name: '.NET', workloadKind: 'STANDARD', installed: false },
        { workloadId: 'aspire', name: 'Aspire', workloadKind: 'STANDARD', installed: false },
      ]),
    });

    const result = await handleCloudHostToolRequest(
      { userId: USER_ID, sessionId: SESSION_ID },
      { method: 'tools/call', params: { name: 'workload_list', arguments: {} } },
      service,
    );

    const payload = JSON.parse((result.result as any).content[0].text);
    expect(payload.map((item: any) => item.name)).toEqual(['Docker', '.NET', 'Aspire']);
    expect(payload[0]).toMatchObject({ workloadKind: 'STANDARD', installed: true });

    const tools = (
      await handleCloudHostToolRequest(
        { userId: USER_ID, sessionId: SESSION_ID },
        { method: 'tools/list' },
        service,
      )
    ).result as any;
    expect(tools.tools[0].description).toContain('Aspire');
  });

  it('T-CHM-L2: workload_install 失败返回 isError 且不含 token', async () => {
    vi.mocked(Session.findOne).mockReturnValue(
      lean({ _id: SESSION_ID, controllerId: CONTROLLER_ID }),
    );
    vi.mocked(Controller.findOne).mockReturnValue(lean({ _id: CONTROLLER_ID, type: 'cloud' }));
    vi.mocked(CloudHost.findOne).mockReturnValue(
      lean({ _id: 'host1', controllerId: CONTROLLER_ID }),
    );
    const service = makeService({
      createInstallOperation: vi
        .fn()
        .mockRejectedValue(new Error('安装失败 token=ghp_secret123')),
    });

    const result = await handleCloudHostToolRequest(
      { userId: USER_ID, sessionId: SESSION_ID },
      {
        method: 'tools/call',
        params: { name: 'workload_install', arguments: { workloadId: 'w1' } },
      },
      service,
    );

    expect((result.result as any).isError).toBe(true);
    expect((result.result as any).content[0].text).toContain('安装失败');
    expect((result.result as any).content[0].text).not.toContain('ghp_secret123');
  });

  it('T-CHM4: workload_install 等待终态并返回摘要', async () => {
    vi.mocked(Session.findOne).mockReturnValue(
      lean({ _id: SESSION_ID, controllerId: CONTROLLER_ID }),
    );
    vi.mocked(Controller.findOne).mockReturnValue(lean({ _id: CONTROLLER_ID, type: 'cloud' }));
    vi.mocked(CloudHost.findOne).mockReturnValue(
      lean({ _id: 'host1', controllerId: CONTROLLER_ID }),
    );
    const service = makeService();

    const result = await handleCloudHostToolRequest(
      { userId: USER_ID, sessionId: SESSION_ID },
      {
        method: 'tools/call',
        params: { name: 'workload_install', arguments: { workloadId: 'w1' } },
      },
      service,
    );
    expect(service.createInstallOperation).toHaveBeenCalledWith({
      userId: USER_ID,
      controllerId: CONTROLLER_ID,
      workloadId: 'w1',
      params: undefined,
    });
    expect(service.waitForCompletion).toHaveBeenCalled();
    expect((result.result as any).content[0].text).toContain('SUCCEEDED');
  });
});
