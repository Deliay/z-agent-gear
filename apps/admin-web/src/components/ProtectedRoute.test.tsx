import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import ProtectedRoute from './ProtectedRoute';
import { AuthProvider } from '../stores/AuthProvider';

function renderWithProviders(initialEntry = '/') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <AuthProvider>
        <Routes>
          <Route element={<ProtectedRoute />}>
            <Route path="/" element={<div>protected content</div>} />
          </Route>
          <Route path="/login" element={<div>login page</div>} />
          <Route path="/change-password" element={<div>change password page</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('ProtectedRoute', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('T-F3: redirects to /login when there is no token', () => {
    renderWithProviders('/');
    expect(screen.getByText('login page')).toBeDefined();
  });

  it('T-F4: redirects to /change-password when mustChangePassword is true', () => {
    localStorage.setItem('admin_token', 'valid-token');
    localStorage.setItem(
      'admin_user',
      JSON.stringify({ id: '1', username: 'admin', mustChangePassword: true }),
    );
    renderWithProviders('/');
    expect(screen.getByText('change password page')).toBeDefined();
  });

  it('renders protected content when authenticated and password changed', () => {
    localStorage.setItem('admin_token', 'valid-token');
    localStorage.setItem(
      'admin_user',
      JSON.stringify({ id: '1', username: 'admin', mustChangePassword: false }),
    );
    renderWithProviders('/');
    expect(screen.getByText('protected content')).toBeDefined();
  });
});
