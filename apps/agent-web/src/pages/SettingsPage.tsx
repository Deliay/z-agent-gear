import { useNavigate } from 'react-router-dom';
import { useAuth } from '../stores/auth';

export default function SettingsPage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className="grid h-full grid-cols-[200px_1fr]">
      <aside className="border-r border-gray-200 p-4">
        <nav className="space-y-1">
          <div className="rounded-md bg-blue-50 px-3 py-2 text-sm font-medium text-blue-700">
            帐号
          </div>
        </nav>
      </aside>
      <div className="p-8">
        <h2 className="mb-6 text-xl font-semibold text-gray-900">帐号</h2>
        <div className="space-y-4">
          <div>
            <span className="block text-sm font-medium text-gray-700">用户名</span>
            <p className="mt-1 text-gray-900">{user?.username ?? ''}</p>
          </div>
          <button
            type="button"
            onClick={handleLogout}
            className="rounded-md bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700"
          >
            退出登录
          </button>
        </div>
      </div>
    </div>
  );
}
