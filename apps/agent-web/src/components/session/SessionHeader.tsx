interface Session {
  id: string;
  userId: string;
  controllerId: string;
  controllerName: string;
  acpServerType: string;
  status: string;
  externalSessionId: string | null;
  cwd: string | null;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
}

interface SessionHeaderProps {
  session: Session | null;
  status: string;
  onClose: () => void;
  onDelete: () => void;
}

export default function SessionHeader({ session, status, onClose, onDelete }: SessionHeaderProps) {
  const getStatusColor = (status: string) => {
    switch (status) {
      case 'running':
        return 'bg-green-100 text-green-800';
      case 'connecting':
        return 'bg-yellow-100 text-yellow-800';
      case 'creating':
        return 'bg-blue-100 text-blue-800';
      case 'disconnected':
        return 'bg-orange-100 text-orange-800';
      case 'ended':
        return 'bg-gray-100 text-gray-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  return (
    <div className="flex items-center justify-between border-b border-gray-200 bg-white px-4 py-3">
      <div className="flex items-center gap-4">
        <h1 className="text-lg font-semibold">
          {session?.controllerName || 'Session'}
        </h1>
        <span className={`rounded-full px-2 py-1 text-xs font-medium ${getStatusColor(status)}`}>
          {status}
        </span>
        {session?.acpServerType && (
          <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600">
            {session.acpServerType}
          </span>
        )}
        {session?.cwd && (
          <span className="text-sm text-gray-500 font-mono">{session.cwd}</span>
        )}
        {session?.createdAt && (
          <span className="text-xs text-gray-400">
            {new Date(session.createdAt).toLocaleString()}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        {status !== 'ended' && (
          <button
            type="button"
            onClick={onClose}
            className="rounded-md bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-700"
          >
            Close
          </button>
        )}
        <button
          type="button"
          onClick={onDelete}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
        >
          Delete
        </button>
      </div>
    </div>
  );
}
