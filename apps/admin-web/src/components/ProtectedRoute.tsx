import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '@/stores/auth';

export default function ProtectedRoute() {
  const { token, mustChangePassword } = useAuth();

  if (!token) {
    return <Navigate to="/login" replace />;
  }

  if (mustChangePassword) {
    return <Navigate to="/change-password" replace />;
  }

  return <Outlet />;
}
