import { Outlet } from 'react-router-dom';
import { useAuth } from '../stores/auth';
import Sidebar from '../components/Sidebar';

export default function MainLayout() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-300 border-t-blue-600" />
      </div>
    );
  }

  return (
    <div className="grid h-screen grid-cols-[240px_1fr]">
      <Sidebar username={user?.username ?? ''} />
      <main className="overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
