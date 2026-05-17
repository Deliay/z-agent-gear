import { Outlet } from 'react-router-dom';
import { useAuth } from '../stores/auth';
import Sidebar from '../components/Sidebar';

export default function MainLayout() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <output className="flex h-screen items-center justify-center" aria-label="Loading…">
        <div className="motion-safe:h-8 motion-safe:w-8 motion-safe:animate-spin motion-safe:rounded-full motion-safe:border-4 motion-safe:border-gray-300 motion-safe:border-t-blue-600" />
        <span className="sr-only">Loading…</span>
      </output>
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
