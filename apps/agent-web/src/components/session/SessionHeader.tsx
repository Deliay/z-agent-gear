interface AgentModelInfo {
  id: string;
  name: string;
  provider?: string | null;
}

interface Session {
  id: string;
  userId: string;
  controllerId: string;
  controllerName: string;
  acpServerType: string;
  status: string;
  externalSessionId: string | null;
  cwd: string | null;
  currentModel?: AgentModelInfo | null;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
}

interface SessionHeaderProps {
  session: Session | null;
  status: string;
  onClose: () => void;
  onDelete: () => void;
  onContinue?: () => void;
  resuming?: boolean;
  controllerOnline?: boolean;
}

export default function SessionHeader({ session, status, onClose, onDelete, onContinue, resuming, controllerOnline }: SessionHeaderProps) {
  const getStatusColor = (status: string) => {
    switch (status) {
      case 'idling':
        return 'bg-green-100 text-green-800';
      case 'running':
        return 'bg-blue-100 text-blue-800';
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

  const continueDisabled = resuming || !controllerOnline;

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
        {session?.currentModel && (
          <span className="rounded bg-purple-100 px-1.5 py-0.5 text-xs text-purple-700">
            {session.currentModel.name}
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
        {status !== 'ended' && status !== 'creating' && !resuming && (
          <button
            type="button"
            onClick={onClose}
            className="rounded-md bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-700"
          >
            Close
          </button>
        )}
        {(status === 'ended' || resuming) && (
          <button
            type="button"
            onClick={onContinue}
            disabled={continueDisabled}
            title={!controllerOnline ? 'Controller is offline' : undefined}
            className={`rounded-md px-3 py-1.5 text-sm text-white ${
              continueDisabled
                ? 'cursor-not-allowed bg-gray-400'
                : 'bg-blue-600 hover:bg-blue-700'
            }`}
          >
            {resuming ? 'Continuing...' : 'Continue'}
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
