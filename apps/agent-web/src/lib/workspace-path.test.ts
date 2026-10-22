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
})

describe('previewClonePath', () => {
  it('拼接前缀与 owner/repo', () => {
    expect(previewClonePath('/root/workspace', 'User/Repo')).toBe('/root/workspace/User/Repo')
    expect(previewClonePath('/', 'User/Repo')).toBe('/User/Repo')
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
    expect(workspacePrefixError('root/workspace')).toBe('前缀地址必须以 / 开头')
    expect(workspacePrefixError('/root/../etc')).toBe('前缀地址不能包含 ..')
    expect(workspacePrefixError('/root\\workspace')).toBe('前缀地址包含非法字符')
    expect(workspacePrefixError('/root/workspace')).toBeNull()
  })
})
