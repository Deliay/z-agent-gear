import { useState, useEffect } from 'react';
import { useQuery } from '@apollo/client/react';
import { GET_ACP_CAPABILITIES } from '../../graphql/queries';

interface Controller {
  id: string;
  name: string;
  status: string;
}

interface AcpCapability {
  type: string;
  available: boolean;
  version?: string;
}

interface NewSessionDialogProps {
  controllers: Controller[];
  onClose: () => void;
  onCreate: (controllerId: string, acpServerType: string, cwd?: string) => void;
}

export default function NewSessionDialog({ controllers, onClose, onCreate }: NewSessionDialogProps) {
  const [selectedController, setSelectedController] = useState<string>('');
  const [selectedAcpServer, setSelectedAcpServer] = useState<string>('');
  const [cwd, setCwd] = useState('');

  const onlineControllers = controllers.filter((c) => c.status === 'online');

  const { data: acpData, loading: acpLoading } = useQuery<{ acpCapabilities: AcpCapability[] }>(
    GET_ACP_CAPABILITIES,
    {
      variables: { controllerId: selectedController },
      skip: !selectedController,
    },
  );

  const acpServers = acpData?.acpCapabilities?.filter((s) => s.available) ?? [];

  // Auto-select first available ACP server
  useEffect(() => {
    if (acpServers.length > 0 && !selectedAcpServer) {
      setSelectedAcpServer(acpServers[0].type);
    }
  }, [acpServers, selectedAcpServer]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedController && selectedAcpServer) {
      onCreate(selectedController, selectedAcpServer, cwd || undefined);
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
        <h2 className="mb-4 text-lg font-semibold">New Session</h2>
        <form onSubmit={handleSubmit}>
          <div className="mb-4">
            <label htmlFor="controller" className="mb-2 block text-sm font-medium text-gray-700">
              Controller
            </label>
            <select
              id="controller"
              value={selectedController}
              onChange={(e) => {
                setSelectedController(e.target.value);
                setSelectedAcpServer('');
              }}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              required
            >
              <option value="">Select a controller</option>
              {onlineControllers.map((controller) => (
                <option key={controller.id} value={controller.id}>
                  {controller.name}
                </option>
              ))}
            </select>
            {onlineControllers.length === 0 && (
              <p className="mt-1 text-sm text-red-600">No online controllers available</p>
            )}
          </div>

          {selectedController && (
            <div className="mb-4">
              <div className="mb-2 block text-sm font-medium text-gray-700">
                ACP Server
              </div>
              {acpLoading ? (
                <p className="text-sm text-gray-500">Detecting ACP servers...</p>
              ) : (
                <div className="space-y-2">
                  {(acpServers.length > 0 ? acpServers : [{ type: 'opencode', available: true }]).map((server) => (
                    <label
                      key={server.type}
                      className={`flex cursor-pointer items-center gap-3 rounded-md border p-3 ${
                        selectedAcpServer === server.type
                          ? 'border-blue-500 bg-blue-50'
                          : 'border-gray-200 hover:border-gray-300'
                      }`}
                    >
                      <input
                        type="radio"
                        name="acp-server"
                        value={server.type}
                        checked={selectedAcpServer === server.type}
                        onChange={(e) => setSelectedAcpServer(e.target.value)}
                        className="h-4 w-4 text-blue-600"
                      />
                      <div>
                        <span className="text-sm font-medium text-gray-900">{server.type}</span>
                        {server.version && (
                          <span className="ml-2 text-xs text-gray-500">v{server.version}</span>
                        )}
                      </div>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="mb-6">
            <label htmlFor="cwd" className="mb-2 block text-sm font-medium text-gray-700">
              Working Directory (optional)
            </label>
            <input
              type="text"
              id="cwd"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="/home/user/project"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!selectedController || !selectedAcpServer}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:bg-gray-300 disabled:text-gray-500"
            >
              Create Session
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
