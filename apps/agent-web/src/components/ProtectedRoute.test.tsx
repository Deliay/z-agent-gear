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
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('ProtectedRoute', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('should redirect to /login when no token', () => {
    renderWithProviders('/');
    expect(screen.getByText('login page')).toBeDefined();
  });

  it('should render children when token exists', () => {
    localStorage.setItem('auth_token', 'valid-token');
    renderWithProviders('/');
    expect(screen.getByText('protected content')).toBeDefined();
  });
});
