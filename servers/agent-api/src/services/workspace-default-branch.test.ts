import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  workspaceFindOne: vi.fn(),
  workspaceFindByIdAndUpdate: vi.fn(),
  bindingFindOne: vi.fn(),
  getRepoDefaultBranch: vi.fn(),
  detectGitRepo: vi.fn(),
}));

vi.mock('../models/controller-workspace.js', () => ({
  ControllerWorkspace: {
    findOne: h.workspaceFindOne,
    findByIdAndUpdate: h.workspaceFindByIdAndUpdate,
  },
}));
vi.mock('../models/cloud-host-github-binding.js', () => ({
  CloudHostGithubBinding: { findOne: h.bindingFindOne },
}));
vi.mock('./github.js', () => ({
  githubService: { getRepoDefaultBranch: h.getRepoDefaultBranch },
}));
vi.mock('./controller-workspace.js', () => ({
  controllerWorkspaceService: { detectGitRepo: h.detectGitRepo },
}));

import {
  DEFAULT_BRANCH_CANDIDATES,
  resolveWorkspaceDefaultBranch,
} from './workspace-default-branch.js';

const lean = (value: unknown) => ({ lean: vi.fn().mockResolvedValue(value) });
const USER_ID = 'user-1';
const CONTROLLER_ID = 'ctrl-1';
const WORKSPACE_ID = 'ws-1';
const WORKSPACE_PATH = '/home/worker/workspace/owner/repo';

function workspaceDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: WORKSPACE_ID,
    userId: USER_ID,
    controllerId: CONTROLLER_ID,
    name: 'repo',
    path: WORKSPACE_PATH,
    defaultBranch: null,
    ...overrides,
  };
}

function resolveInput(overrides: Record<string, unknown> = {}) {
  return { userId: USER_ID, controllerId: CONTROLLER_ID, workspaceId: WORKSPACE_ID, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.workspaceFindOne.mockReturnValue(lean(workspaceDoc()));
  h.workspaceFindByIdAndUpdate.mockResolvedValue({});
  h.bindingFindOne.mockReturnValue(lean(null));
  h.getRepoDefaultBranch.mockResolvedValue(null);
  h.detectGitRepo.mockResolvedValue({ isGitRepo: true, branches: [] });
});

describe('resolveWorkspaceDefaultBranch', () => {
  it('WDB1: 已存 defaultBranch 直接返回，不探测不回填', async () => {
    h.workspaceFindOne.mockReturnValue(lean(workspaceDoc({ defaultBranch: 'trunk' })));

    await expect(resolveWorkspaceDefaultBranch(resolveInput())).resolves.toBe('trunk');

    expect(h.getRepoDefaultBranch).not.toHaveBeenCalled();
    expect(h.detectGitRepo).not.toHaveBeenCalled();
    expect(h.workspaceFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('WDB2: 传 repoFullName 且 GitHub API 命中 → 返回并回填', async () => {
    h.getRepoDefaultBranch.mockResolvedValue('trunk');

    await expect(
      resolveWorkspaceDefaultBranch(resolveInput({ repoFullName: 'owner/repo' })),
    ).resolves.toBe('trunk');

    expect(h.getRepoDefaultBranch).toHaveBeenCalledWith(USER_ID, 'owner/repo');
    expect(h.detectGitRepo).not.toHaveBeenCalled();
    expect(h.workspaceFindByIdAndUpdate).toHaveBeenCalledWith(WORKSPACE_ID, {
      defaultBranch: 'trunk',
    });
  });

  it('WDB3: 无 repoFullName 时探测 branches，main 不存在取 master', async () => {
    h.detectGitRepo.mockResolvedValue({ isGitRepo: true, branches: ['develop', 'master'] });

    await expect(resolveWorkspaceDefaultBranch(resolveInput())).resolves.toBe('master');

    expect(h.getRepoDefaultBranch).not.toHaveBeenCalled();
    expect(h.workspaceFindByIdAndUpdate).toHaveBeenCalledWith(WORKSPACE_ID, {
      defaultBranch: 'master',
    });
  });

  it('WDB4: release 候选命中；候选全无 → null 且不回填', async () => {
    h.detectGitRepo.mockResolvedValue({ isGitRepo: true, branches: ['release'] });
    await expect(resolveWorkspaceDefaultBranch(resolveInput())).resolves.toBe('release');

    vi.clearAllMocks();
    h.workspaceFindOne.mockReturnValue(lean(workspaceDoc()));
    h.bindingFindOne.mockReturnValue(lean(null));
    h.detectGitRepo.mockResolvedValue({ isGitRepo: true, branches: ['develop'] });

    await expect(resolveWorkspaceDefaultBranch(resolveInput())).resolves.toBeNull();
    expect(h.workspaceFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('WDB5: 探测回填后再次调用直接复用（不重复探测）', async () => {
    h.detectGitRepo.mockResolvedValue({ isGitRepo: true, branches: ['main'] });

    await expect(resolveWorkspaceDefaultBranch(resolveInput())).resolves.toBe('main');
    expect(h.workspaceFindByIdAndUpdate).toHaveBeenCalledTimes(1);

    h.workspaceFindOne.mockReturnValue(lean(workspaceDoc({ defaultBranch: 'main' })));
    await expect(resolveWorkspaceDefaultBranch(resolveInput())).resolves.toBe('main');
    expect(h.detectGitRepo).toHaveBeenCalledTimes(1);
    expect(h.workspaceFindByIdAndUpdate).toHaveBeenCalledTimes(1);
  });

  it('WDB6: binding 路径严格匹配 → GitHub API 优先并回填', async () => {
    h.bindingFindOne.mockReturnValue(
      lean({ repoFullName: 'owner/repo', targetPath: '/home/worker/workspace' }),
    );
    h.getRepoDefaultBranch.mockResolvedValue('trunk');

    await expect(resolveWorkspaceDefaultBranch(resolveInput())).resolves.toBe('trunk');

    expect(h.bindingFindOne).toHaveBeenCalledWith({ controllerId: CONTROLLER_ID });
    expect(h.getRepoDefaultBranch).toHaveBeenCalledWith(USER_ID, 'owner/repo');
    expect(h.detectGitRepo).not.toHaveBeenCalled();
  });

  it('WDB7: binding 路径不匹配 / detectGitRepo 抛错 → null 且不抛出', async () => {
    h.bindingFindOne.mockReturnValue(
      lean({ repoFullName: 'owner/repo', targetPath: '/home/worker/other' }),
    );
    h.detectGitRepo.mockRejectedValue(new Error('Controller is offline'));

    await expect(resolveWorkspaceDefaultBranch(resolveInput())).resolves.toBeNull();

    expect(h.getRepoDefaultBranch).not.toHaveBeenCalled();
    expect(h.workspaceFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('候选清单顺序为 main → master → release', () => {
    expect(DEFAULT_BRANCH_CANDIDATES).toEqual(['main', 'master', 'release']);
  });
});
