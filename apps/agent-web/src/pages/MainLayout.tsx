import { Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../stores/auth';
import { useIsMobile } from '../hooks/useIsMobile';
import Sidebar from '../components/Sidebar';

export default function MainLayout() {
  const { user, loading } = useAuth();
  const isMobile = useIsMobile();
  const location = useLocation();

  if (loading) {
    return (
      <output className="flex h-screen items-center justify-center" aria-label="Loading…">
        <div className="motion-safe:h-8 motion-safe:w-8 motion-safe:animate-spin motion-safe:rounded-full motion-safe:border-4 motion-safe:border-muted motion-safe:border-t-primary" />
        <span className="sr-only">Loading…</span>
      </output>
    );
  }

  // Desktop: keep existing two-column layout (zero changes)
  if (!isMobile) {
    return (
      <div className="grid h-screen grid-cols-[280px_1fr]">
        <Sidebar username={user?.username ?? ''} />
        <main className="overflow-auto">
          <Outlet />
        </main>
      </div>
    );
  }

  // Mobile: show list or detail based on route
  const path = location.pathname;
  const isSessionDetail = /^\/sessions\/[^/]+$/.test(path);
  const isWorkflowDetail = /^\/workflows\/[^/]+$/.test(path);
  const isSettings = path.startsWith('/settings');

  if (isSessionDetail || isWorkflowDetail || isSettings) {
    return (
      <main className="h-screen overflow-auto">
        <Outlet />
      </main>
    );
  }

  return (
    <div className="h-screen">
      <Sidebar username={user?.username ?? ''} mobile />
    </div>
  );
}
