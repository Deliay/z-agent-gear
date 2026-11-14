import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import SecurityPage from '../SecurityPage'

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  createTicket: vi.fn(),
  unbind: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  mutationCall: { value: 0 },
}))

vi.mock('@apollo/client', () => ({ gql: vi.fn(() => '') }))
vi.mock('@apollo/client/react', () => ({
  useQuery: mocks.useQuery,
  useMutation: vi.fn(() => {
    mocks.mutationCall.value += 1
    const fn = mocks.mutationCall.value === 1 ? mocks.createTicket : mocks.unbind
    return [fn, { loading: false }]
  }),
}))
vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError, message: vi.fn() },
}))
vi.mock('@/lib/auth-oauth', () => ({
  adminBindAuthorizeUrl: (providerId: string, ticket: string) =>
    `http://agent-api/api/auth/oauth/${providerId}/authorize?surface=admin-bind&ticket=${ticket}`,
  mapOauthError: vi.fn(),
}))

function renderPage(entry = '/settings/security') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <SecurityPage />
    </MemoryRouter>,
  )
}

function mockData(bindings: unknown[] = [], providers: unknown[] = []) {
  mocks.useQuery.mockReturnValue({
    data: { adminExternalLogins: bindings, adminAuthProviders: providers },
    loading: false,
    error: undefined,
    refetch: vi.fn(),
  })
}

describe('SecurityPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mutationCall.value = 0
    mocks.createTicket.mockResolvedValue({ data: { createAdminBindTicket: 'bind-ticket' } })
    mocks.unbind.mockResolvedValue({ data: { unbindAdminExternalLogin: true } })
  })

  it('展示已绑定身份与可绑定登录方式', () => {
    mockData(
      [
        {
          id: 'b1',
          providerId: 'p1',
          providerDisplayName: '公司 SSO',
          externalUsername: 'zhangsan',
          createdAt: new Date().toISOString(),
        },
      ],
      [{ id: 'p2', type: 'oidc', displayName: '备用 SSO' }],
    )
    renderPage()
    expect(screen.getByText('公司 SSO · zhangsan')).toBeDefined()
    expect(screen.getByText('备用 SSO')).toBeDefined()
    expect(screen.getByRole('button', { name: '绑定' })).toBeDefined()
  })

  it('绑定入口创建票据后跳转 agent-api 授权地址', async () => {
    mockData([], [{ id: 'p2', type: 'oidc', displayName: '备用 SSO' }])
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: '绑定' }))
    await waitFor(() => expect(mocks.createTicket).toHaveBeenCalledWith({ variables: { providerId: 'p2' } }))
  })

  it('解绑二次确认后调用解绑 mutation', async () => {
    mockData(
      [
        {
          id: 'b1',
          providerId: 'p1',
          providerDisplayName: '公司 SSO',
          externalUsername: 'zhangsan',
          createdAt: new Date().toISOString(),
        },
      ],
      [],
    )
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: '解绑' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('解绑后将无法再使用该身份登录后台')
    fireEvent.click(within(dialog).getByRole('button', { name: '解绑' }))
    await waitFor(() => expect(mocks.unbind).toHaveBeenCalledWith({ variables: { id: 'b1' } }))
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith('已解绑'))
  })

  it('bind=success 展示成功提示', () => {
    mockData()
    renderPage('/settings/security?bind=success')
    expect(mocks.toastSuccess).toHaveBeenCalledWith('外部身份绑定成功')
  })

  it('bind=error 展示错误码', () => {
    mockData()
    renderPage('/settings/security?bind=error&error=already_bound')
    expect(mocks.toastError).toHaveBeenCalledWith('绑定失败：already_bound')
  })
})
