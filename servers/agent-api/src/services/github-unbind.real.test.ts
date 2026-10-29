import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { GitHubAccount } from '../models/github-account.js';
import { GitHubInstallation } from '../models/github-installation.js';
import { githubService, resetRepoTokenCache } from './github.js';
import { runWithWorkspace, type WorkspaceContext } from './workspace-context.js';

let server: MongoMemoryServer;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri('agent-api-github-unbind-test'));
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  await mongoose.connection.collection('githubaccounts').deleteMany({});
  await mongoose.connection.collection('githubinstallations').deleteMany({});
  resetRepoTokenCache();
});

const TENANT = new mongoose.Types.ObjectId();
const WS_GLOBAL = new mongoose.Types.ObjectId();
const WS_NORMAL = new mongoose.Types.ObjectId();
const USER = '507f1f77bcf86cd799439091';

function ctx(id: mongoose.Types.ObjectId, type: 'global' | 'normal'): WorkspaceContext {
  return {
    id: String(id),
    tenantId: String(TENANT),
    type,
    role: type === 'global' ? 'admin' : 'developer',
    readOnly: false,
    globalWorkspaceId: String(WS_GLOBAL),
  };
}

async function seedDoubleBinding() {
  const globalAccount = await GitHubAccount.create({
    userId: USER,
    tenantId: String(TENANT),
    workspaceId: String(WS_GLOBAL),
    githubUserId: 4242,
    githubLogin: 'octo',
    accessToken: 'token',
  });
  const normalAccount = await GitHubAccount.create({
    userId: USER,
    tenantId: String(TENANT),
    workspaceId: String(WS_NORMAL),
    githubUserId: 4242,
    githubLogin: 'octo',
    accessToken: 'token',
  });
  await GitHubInstallation.create({
    accountId: globalAccount._id,
    githubUserId: 4242,
    installationId: 777,
    accountLogin: 'octo',
    accountType: 'User',
    repos: [],
  });
  return { globalAccount, normalAccount };
}

describe('unbindAccount 跨工作区共享安装数据（阻断-I，真库）', () => {
  it('解绑全局行时保留 normal 存活绑定的安装数据且不卸载 App', async () => {
    const { globalAccount, normalAccount } = await seedDoubleBinding();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const removed = await runWithWorkspace(ctx(WS_GLOBAL, 'global'), async () =>
      githubService.unbindAccount(USER, String(globalAccount._id)),
    );
    vi.unstubAllGlobals();

    expect(removed).toBe(true);
    // App 未卸载
    expect(fetchMock).not.toHaveBeenCalled();
    // 安装数据保留，并改指存活绑定
    const installation = await GitHubInstallation.findOne({ installationId: 777 }).lean();
    expect(installation).not.toBeNull();
    expect(String(installation?.accountId)).toBe(String(normalAccount._id));
    expect(String(installation?.githubUserId)).toBe('4242');
    // 存活绑定仍能看到安装数据
    const accounts = await runWithWorkspace(ctx(WS_NORMAL, 'normal'), async () =>
      githubService.getAccounts(USER),
    );
    expect(accounts.find((a) => a.id === String(normalAccount._id))?.installations).toHaveLength(1);
  });

  it('解绑最后一个绑定时才卸载 App 并删除安装数据', async () => {
    const { normalAccount } = await seedDoubleBinding();
    // 先直接删掉全局绑定，仅保留 normal
    await GitHubAccount.deleteMany({ workspaceId: String(WS_GLOBAL) });
    await GitHubInstallation.updateOne(
      { installationId: 777 },
      { $set: { accountId: normalAccount._id } },
    );

    const uninstallSpy = vi
      .spyOn(githubService as unknown as { uninstallApp: (id: number) => Promise<void> }, 'uninstallApp')
      .mockResolvedValue(undefined);
    const removed = await runWithWorkspace(ctx(WS_NORMAL, 'normal'), async () =>
      githubService.unbindAccount(USER, String(normalAccount._id)),
    );
    expect(uninstallSpy).toHaveBeenCalledWith(777);
    uninstallSpy.mockRestore();

    expect(removed).toBe(true);
    expect(await GitHubInstallation.countDocuments({ githubUserId: 4242 })).toBe(0);
  });
});
