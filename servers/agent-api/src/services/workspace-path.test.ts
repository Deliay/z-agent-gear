import { describe, it, expect } from 'vitest';
import { normalizeWorkspacePrefix, resolveClonePath } from './workspace-path.js';

describe('normalizeWorkspacePrefix', () => {
  it('T-PATH1: 保留标准绝对路径', () => {
    expect(normalizeWorkspacePrefix('/home/worker/workspace')).toBe('/home/worker/workspace');
  });

  it('T-PATH2: 合并重复斜杠与 . 并去掉末尾斜杠', () => {
    expect(normalizeWorkspacePrefix('/home/worker//workspace/')).toBe('/home/worker/workspace');
    expect(normalizeWorkspacePrefix('/home/worker/./workspace///')).toBe('/home/worker/workspace');
  });

  it('T-PATH2: 根路径保留为 /', () => {
    expect(normalizeWorkspacePrefix('/')).toBe('/');
    expect(normalizeWorkspacePrefix('///')).toBe('/');
  });

  it('T-PATH3: 空串/全空白拒绝', () => {
    expect(() => normalizeWorkspacePrefix('')).toThrow('前缀地址不能为空');
    expect(() => normalizeWorkspacePrefix('   ')).toThrow('前缀地址不能为空');
  });

  it('T-PATH3: 相对路径拒绝', () => {
    expect(() => normalizeWorkspacePrefix('root/workspace')).toThrow('前缀地址必须以 / 或 ~ 开头');
    expect(() => normalizeWorkspacePrefix('./workspace')).toThrow('前缀地址必须以 / 或 ~ 开头');
  });

  it('T-PATH8: ~ 展开矩阵（仅首字符 ~ 展开为 /home/worker）', () => {
    expect(normalizeWorkspacePrefix('~')).toBe('/home/worker');
    expect(normalizeWorkspacePrefix('~/')).toBe('/home/worker');
    expect(normalizeWorkspacePrefix('~/workspace')).toBe('/home/worker/workspace');
    expect(normalizeWorkspacePrefix('~/workspace/')).toBe('/home/worker/workspace');
    expect(normalizeWorkspacePrefix('~//a')).toBe('/home/worker/a');
    expect(() => normalizeWorkspacePrefix('~/a/../b')).toThrow('前缀地址不能包含 ..');
    expect(() => normalizeWorkspacePrefix('~/..')).toThrow('前缀地址不能包含 ..');
  });

  it('T-PATH9: ~abc 拒绝；/a/~ 不展开不拒绝', () => {
    expect(() => normalizeWorkspacePrefix('~abc')).toThrow('前缀地址必须以 / 或 ~ 开头');
    expect(() => normalizeWorkspacePrefix('~x/y')).toThrow('前缀地址必须以 / 或 ~ 开头');
    expect(normalizeWorkspacePrefix('/a/~')).toBe('/a/~');
    expect(normalizeWorkspacePrefix('/a/~/b')).toBe('/a/~/b');
  });

  it('T-PATH4: 含 .. 段拒绝', () => {
    expect(() => normalizeWorkspacePrefix('/home/worker/../etc')).toThrow('前缀地址不能包含 ..');
    expect(() => normalizeWorkspacePrefix('/home/worker/workspace/..')).toThrow('前缀地址不能包含 ..');
  });

  it('T-PATH5: 含反斜杠或 NUL 拒绝', () => {
    expect(() => normalizeWorkspacePrefix('/home/worker\\workspace')).toThrow('前缀地址包含非法字符');
    expect(() => normalizeWorkspacePrefix('/home/worker/work\0space')).toThrow('前缀地址包含非法字符');
  });
});

describe('resolveClonePath', () => {
  it('T-PATH1: 前缀 + owner/repo 拼接', () => {
    expect(resolveClonePath('/home/worker/workspace', 'User/Repo')).toBe('/home/worker/workspace/User/Repo');
  });

  it('T-PATH7: 根前缀拼接', () => {
    expect(resolveClonePath('/', 'User/Repo')).toBe('/User/Repo');
  });

  it('T-PATH8: ~/workspace 前缀拼接', () => {
    expect(resolveClonePath(normalizeWorkspacePrefix('~/workspace'), 'User/Repo')).toBe(
      '/home/worker/workspace/User/Repo',
    );
  });

  it('T-PATH6: repo 两段为 . / .. 时拒绝穿越', () => {
    expect(() => resolveClonePath('/home/worker/workspace', 'owner/..')).toThrow('仓库格式应为 owner/repo');
    expect(() => resolveClonePath('/home/worker/workspace', '../repo')).toThrow('仓库格式应为 owner/repo');
    expect(() => resolveClonePath('/home/worker/workspace', './repo')).toThrow('仓库格式应为 owner/repo');
  });

  it('T-PATH6: 非法 repo 格式拒绝', () => {
    expect(() => resolveClonePath('/home/worker/workspace', 'repo')).toThrow('仓库格式应为 owner/repo');
    expect(() => resolveClonePath('/home/worker/workspace', 'a/b/c')).toThrow('仓库格式应为 owner/repo');
    expect(() => resolveClonePath('/home/worker/workspace', 'owner/re po')).toThrow(
      '仓库格式应为 owner/repo',
    );
  });
});
