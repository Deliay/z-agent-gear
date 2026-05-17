import { useState } from 'react';
import { NavLink } from 'react-router-dom';

interface SidebarProps {
  username: string;
}

export default function Sidebar({ username }: SidebarProps) {
  const [sessions] = useState(() =>
    Array.from({ length: 20 }, (_, i) => `Session ${i + 1}`)
  );

  return (
    <nav className="flex h-screen flex-col bg-gray-900 text-white" aria-label="Sidebar">
      <div className="flex-1 overflow-y-auto p-4">
        <h2 className="mb-4 text-lg font-semibold">Sessions</h2>
        <ul className="space-y-1">
          {sessions.map((session) => (
            <li key={session}>
              <button
                type="button"
                className="w-full rounded px-3 py-2 text-left text-sm text-gray-400 transition-colors hover:bg-gray-800 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500"
              >
                {session}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="sticky bottom-0 border-t border-gray-700 p-4">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <span className="truncate text-sm font-medium">{username}</span>
          <NavLink
            to="/settings"
            aria-label="Settings"
            className={({ isActive }) =>
              `rounded p-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 ${
                isActive ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white'
              }`
            }
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-5 w-5"
              viewBox="0 0 20 20"
              fill="currentColor"
              aria-hidden="true"
            >
              <path
                fillRule="evenodd"
                d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z"
                clipRule="evenodd"
              />
            </svg>
          </NavLink>
        </div>
      </div>
    </nav>
  );
}
