import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import AuthProvidersPage from '../AuthProvidersPage'

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  mutations: [] as Array<ReturnType<typeof vi.fn>>,
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('@apollo/client', () => ({ gql: vi.fn(() => '') }))
vi.mock('@apollo/client/react', () => ({
  useQuery: mocks.useQuery,
  useMutation: vi.fn(() => {
    const fn = vi.fn().mockResolvedValue({ data: {} })
    mocks.mutations.push(fn)
    return [fn, { loading: false }]
  }),
}))
vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError, message: vi.fn() },
}))

const provider = {
  id: 'p1',
  type: 'oidc',
  displayName: '公司 SSO',
  issuer: 'https://idp.example.com',
  clientId: 'client-1',
  scopes: 'openid profile email',
  callbackUrl: 'http://localhost:10001/api/auth/oauth/callback',
  enabled: true,
  enableFrontLogin: true,
  enableAdminLogin: false,
  hasSecret: true,
}

const github = {
  id: 'g1',
  type: 'github_oauth',
  clientId: 'gh-client',
  enabled: false,
  enableFrontLogin: true,
  enableAdminLogin: false,
  hasSecret: true,
  callbackUrl: 'http://localhost:10001/api/auth/oauth/callback',
}

interface MutationArgs {
  variables?: { id?: string; input?: Record<string, unknown> }
}

function calledWith(predicate: (args: MutationArgs) => boolean) {
  return mocks.mutations.find((fn) => fn.mock.calls.some((call) => predicate(call[0] as MutationArgs)))
}

function mockQueries(providers = [provider], githubConfig: typeof github | null = github) {
  // 两个 useQuery 共用同一返回（文档被 gql mock 成空串，无法按文档区分）：
  // 组件分别读取 oidcProviders / githubOauthConfig。
  mocks.useQuery.mockReturnValue({
    data: { oidcProviders: providers, githubOauthConfig: githubConfig },
    loading: false,
    error: undefined,
    refetch: vi.fn(),
  })
}

describe('AuthProvidersPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mutations.length = 0
  })

  it('展示 OIDC 列表、回调地址与「Secret 已设置」，不回显 secret', () => {
    mockQueries()
    render(<AuthProvidersPage />)

    expect(screen.getByText('公司 SSO')).toBeDefined()
    expect(screen.getByText('https://idp.example.com')).toBeDefined()
    expect(screen.getAllByText('http://localhost:10001/api/auth/oauth/callback').length).toBeGreaterThan(0)
    expect(screen.getByText(/Secret: 已设置/)).toBeDefined()
    expect(document.body.textContent).not.toContain('encryptedClientSecret')
  })

  it('编辑时 secret 恒为空占位（留空 = 不变）', () => {
    mockQueries()
    render(<AuthProvidersPage />)

    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    const secret = document.querySelector('#oidc-secret') as HTMLInputElement
    expect(secret.value).toBe('')
    expect(secret.placeholder).toBe('已设置（留空保持不变）')

    fireEvent.change(document.querySelector('#oidc-name') as HTMLInputElement, {
      target: { value: '公司 SSO 2' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    return waitFor(() => {
      expect(calledWith((args) => args.variables?.id === 'p1')).toBeDefined()
      const call = calledWith((args) => args.variables?.id === 'p1')!.mock.calls[0][0]
      expect(call.variables.input).not.toHaveProperty('clientSecret')
    })
  })

  it('新增 OIDC 提交 secret；成功后关闭弹窗', async () => {
    mockQueries([])
    render(<AuthProvidersPage />)

    fireEvent.click(screen.getByRole('button', { name: '新增 OIDC Provider' }))
    fireEvent.change(document.querySelector('#oidc-name') as HTMLInputElement, { target: { value: '新 SSO' } })
    fireEvent.change(document.querySelector('#oidc-issuer') as HTMLInputElement, { target: { value: 'https://new.example.com' } })
    fireEvent.change(document.querySelector('#oidc-client-id') as HTMLInputElement, { target: { value: 'new-client' } })
    fireEvent.change(document.querySelector('#oidc-secret') as HTMLInputElement, { target: { value: 'new-secret' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(calledWith((args) => args.variables?.input?.displayName === '新 SSO')).toBeDefined()
      const call = calledWith((args) => args.variables?.input?.displayName === '新 SSO')!.mock.calls[0][0]
      expect(call.variables.input).toMatchObject({
        displayName: '新 SSO',
        issuer: 'https://new.example.com',
        clientId: 'new-client',
        clientSecret: 'new-secret',
      })
    })
    await waitFor(() => expect(document.querySelector('#oidc-name')).toBeNull())
  })

  it('GitHub 配置保存时 secret 留空不覆盖', async () => {
    mockQueries([], github)
    render(<AuthProvidersPage />)

    fireEvent.click(screen.getByRole('button', { name: '保存 GitHub 配置' }))
    await waitFor(() => {
      const fn = calledWith((args) => args.variables?.input?.enabled === false)
      expect(fn).toBeDefined()
      expect(fn!.mock.calls[0][0].variables.input).not.toHaveProperty('clientSecret')
    })
  })
})
