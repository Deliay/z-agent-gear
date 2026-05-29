import { useState } from 'react';
import { useMutation } from '@apollo/client/react';
import { CREATE_PORT_FORWARD } from '../graphql/mutations';
import { GET_PORT_FORWARDS } from '../graphql/queries';
import type { CreatePortForwardMutation } from '../graphql/types';

interface PortForwardDialogProps {
  controllerId: string;
  onClose: () => void;
}

export default function PortForwardDialog({ controllerId, onClose }: PortForwardDialogProps) {
  const [port, setPort] = useState('');
  const [error, setError] = useState('');

  const [createPortForward, { loading }] = useMutation<CreatePortForwardMutation>(
    CREATE_PORT_FORWARD,
    {
      refetchQueries: [{ query: GET_PORT_FORWARDS, variables: { controllerId } }],
      onCompleted: () => onClose(),
      onError: (err) => setError(err.message),
    },
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const portNum = parseInt(port, 10);
    if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
      setError('端口范围: 1-65535');
      return;
    }
    createPortForward({ variables: { controllerId, port: portNum } });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-80 rounded-lg bg-popover p-4 shadow-lg">
        <h3 className="mb-3 text-sm font-medium text-popover-foreground">新建端口转发</h3>
        <form onSubmit={handleSubmit}>
          <input
            type="number"
            min={1}
            max={65535}
            placeholder="端口号 (1-65535)"
            value={port}
            onChange={(e) => setPort(e.target.value)}
            className="mb-2 w-full rounded border border-input bg-background px-3 py-1.5 text-sm text-foreground placeholder-muted-foreground focus:border-ring focus:outline-none"
            autoFocus
          />
          {error && <p className="mb-2 text-xs text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded px-3 py-1.5 text-sm text-foreground hover:bg-accent"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={loading}
              className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {loading ? '创建中...' : '创建'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
