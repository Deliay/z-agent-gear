import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../stores/auth';

export default function ProtectedRoute() {
  const { token, loading } = useAuth();

  if (loading) {
    return (
      <output className="flex h-screen items-center justify-center" aria-label="Loading…">
        <div className="motion-safe:h-8 motion-safe:w-8 motion-safe:animate-spin motion-safe:rounded-full motion-safe:border-4 motion-safe:border-gray-300 motion-safe:border-t-blue-600" />
        <span className="sr-only">Loading…</span>
      </output>
    );
  }

  if (!token) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}
