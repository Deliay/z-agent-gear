import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../stores/auth';

export default function ProtectedRoute() {
  const { token, loading } = useAuth();

  if (loading) {
    return (
      <output className="flex h-screen items-center justify-center" aria-label="加载中…">
        <div className="motion-safe:h-8 motion-safe:w-8 motion-safe:animate-spin motion-safe:rounded-full motion-safe:border-4 motion-safe:border-input motion-safe:border-t-info" />
        <span className="sr-only">加载中…</span>
      </output>
    );
  }

  if (!token) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}
