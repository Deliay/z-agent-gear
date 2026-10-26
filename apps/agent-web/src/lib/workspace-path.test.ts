import { describe, it, expect } from 'vitest'
import {
  normalizeWorkspacePrefixForPreview,
  previewClonePath,
  workspacePrefixError,
} from './workspace-path'

describe('normalizeWorkspacePrefixForPreview', () => {
  it('保留标准前缀并合并重复斜杠/末斜杠', () => {
    expect(normalizeWorkspacePrefixForPreview('/root/workspace')).toBe('/root/workspace')
    expect(normalizeWorkspacePrefixForPreview('/root//workspace/')).toBe('/root/workspace')
    expect(normalizeWorkspacePrefixForPreview('/')).toBe('/')
  })

  it('空/相对路径/含 .. 返回 null', () => {
    expect(normalizeWorkspacePrefixForPreview('')).toBeNull()
    expect(normalizeWorkspacePrefixForPreview('root/workspace')).toBeNull()
    expect(normalizeWorkspacePrefixForPreview('/root/../etc')).toBeNull()
    expect(normalizeWorkspacePrefixForPreview('/root\\workspace')).toBeNull()
  })

  it('T-PATH8: ~ 展开矩阵（仅首字符 ~ 展开为 /root）', () => {
    expect(normalizeWorkspacePrefixForPreview('~')).toBe('/root')
    expect(normalizeWorkspacePrefixForPreview('~/')).toBe('/root')
    expect(normalizeWorkspacePrefixForPreview('~/workspace')).toBe('/root/workspace')
    expect(normalizeWorkspacePrefixForPreview('~/workspace/')).toBe('/root/workspace')
    expect(normalizeWorkspacePrefixForPreview('~//a')).toBe('/root/a')
    expect(normalizeWorkspacePrefixForPreview('~/a/../b')).toBeNull()
    expect(normalizeWorkspacePrefixForPreview('~/..')).toBeNull()
  })

  it('T-PATH9: ~abc 非法；/a/~ 不展开不拒绝', () => {
    expect(normalizeWorkspacePrefixForPreview('~abc')).toBeNull()
    expect(normalizeWorkspacePrefixForPreview('~x/y')).toBeNull()
    expect(normalizeWorkspacePrefixForPreview('/a/~')).toBe('/a/~')
    expect(normalizeWorkspacePrefixForPreview('/a/~/b')).toBe('/a/~/b')
  })
})

describe('previewClonePath', () => {
  it('拼接前缀与 owner/repo', () => {
    expect(previewClonePath('/root/workspace', 'User/Repo')).toBe('/root/workspace/User/Repo')
    expect(previewClonePath('/', 'User/Repo')).toBe('/User/Repo')
  })

  it('T-PATH8: ~/workspace 前缀展开后拼接', () => {
    expect(previewClonePath('~/workspace', 'alice/repo-a')).toBe('/root/workspace/alice/repo-a')
  })

  it('非法前缀或仓库返回 null', () => {
    expect(previewClonePath('', 'User/Repo')).toBeNull()
    expect(previewClonePath('/root/workspace', '')).toBeNull()
    expect(previewClonePath('/root/workspace', 'owner/..')).toBeNull()
    expect(previewClonePath('/root/workspace', 'repo')).toBeNull()
  })
})

describe('workspacePrefixError', () => {
  it('按输入返回对应提示', () => {
    expect(workspacePrefixError('')).toBe('请输入前缀地址')
    expect(workspacePrefixError('root/workspace')).toBe('前缀地址必须以 / 或 ~ 开头')
    expect(workspacePrefixError('/root/../etc')).toBe('前缀地址不能包含 ..')
    expect(workspacePrefixError('/root\\workspace')).toBe('前缀地址包含非法字符')
    expect(workspacePrefixError('/root/workspace')).toBeNull()
  })

  it('T-PATH9: ~ 合法形态无提示；~abc 提示起始字符错误', () => {
    expect(workspacePrefixError('~/workspace')).toBeNull()
    expect(workspacePrefixError('~')).toBeNull()
    expect(workspacePrefixError('~abc')).toBe('前缀地址必须以 / 或 ~ 开头')
    expect(workspacePrefixError('~x/y')).toBe('前缀地址必须以 / 或 ~ 开头')
    expect(workspacePrefixError('/a/~')).toBeNull()
    expect(workspacePrefixError('~/a/../b')).toBe('前缀地址不能包含 ..')
  })

  it('混合非法输入时与后端同序（先判非法字符再判绝对路径）', () => {
    expect(workspacePrefixError('root\\workspace')).toBe('前缀地址包含非法字符')
    expect(workspacePrefixError('root/../etc')).toBe('前缀地址必须以 / 或 ~ 开头')
  })
})
