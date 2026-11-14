import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider } from '../../stores/AuthProvider'
import LoginCallbackPage from '../LoginCallbackPage'

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  captured: { current: null as null | { onCompleted?: (data: unknown) => void; onError?: () => void } },
}))

vi.mock('@apollo/client', () => ({ gql: vi.fn(() => '') }))
vi.mock('@apollo/client/react', () => ({
  useMutation: vi.fn((_doc: unknown, options: unknown) => {
    mocks.captured.current = options as typeof mocks.captured.current
    return [mocks.mutate, { loading: false }]
  }),
}))

function renderAt(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <AuthProvider>
        <Routes>
          <Route path="/login/callback" element={<LoginCallbackPage />} />
          <Route path="/login" element={<div>login page</div>} />
          <Route path="/models" element={<div>models page</div>} />
          <Route path="/change-password" element={<div>change password page</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('LoginCallbackPage', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
  })

  it('兑换 ticket 成功后进入 /models', () => {
    renderAt('/login/callback?ticket=t1')
    expect(mocks.mutate).toHaveBeenCalledWith({ variables: { ticket: 't1' } })

    act(() => {
      mocks.captured.current?.onCompleted?.({
        adminExchangeLoginTicket: {
          token: 'admin-jwt',
          admin: { id: 'a1', username: 'admin', mustChangePassword: false },
        },
      })
    })

    expect(localStorage.getItem('admin_token')).toBe('admin-jwt')
    expect(screen.getByText('models page')).toBeDefined()
  })

  it('mustChangePassword 时进入改密页', () => {
    renderAt('/login/callback?ticket=t2')
    act(() => {
      mocks.captured.current?.onCompleted?.({
        adminExchangeLoginTicket: {
          token: 'admin-jwt',
          admin: { id: 'a1', username: 'admin', mustChangePassword: true },
        },
      })
    })
    expect(screen.getByText('change password page')).toBeDefined()
  })

  it('携带 error 时展示映射文案且不兑换', () => {
    renderAt('/login/callback?error=not_bound')
    expect(mocks.mutate).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('该身份未绑定任何管理员账户')
  })

  it('缺少 ticket 时提示重新登录', () => {
    renderAt('/login/callback')
    expect(mocks.mutate).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('登录票据缺失')
  })

  it('兑换失败时提示票据无效', () => {
    renderAt('/login/callback?ticket=expired')
    act(() => {
      mocks.captured.current?.onError?.()
    })
    expect(screen.getByRole('alert').textContent).toContain('登录票据无效或已过期')
  })
})
