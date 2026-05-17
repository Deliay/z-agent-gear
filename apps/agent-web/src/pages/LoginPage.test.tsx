import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../stores/AuthProvider';
import LoginPage from './LoginPage';

vi.mock('@apollo/client', () => ({
  gql: vi.fn(() => ''),
}));

vi.mock('@apollo/client/react', () => ({
  useMutation: vi.fn(() => [
    vi.fn(),
    { loading: false, error: undefined, data: undefined },
  ]),
}));

describe('LoginPage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('should render login form', () => {
    render(
      <MemoryRouter>
        <AuthProvider>
          <LoginPage />
        </AuthProvider>
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: '登录' })).toBeDefined();
    expect(screen.getByLabelText('用户名')).toBeDefined();
    expect(screen.getByLabelText('密码')).toBeDefined();
  });
});
