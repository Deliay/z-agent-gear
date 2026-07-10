import { useState } from 'react';
import { useMutation } from '@apollo/client/react';
import { CREATE_GATEWAY } from '../graphql/mutations';
import { GET_GATEWAYS } from '../graphql/queries';
import type { CreateGatewayMutation } from '../graphql/types';

interface GatewayDialogProps {
  controllerId: string;
  onClose: () => void;
}

export default function GatewayDialog({ controllerId, onClose }: GatewayDialogProps) {
  const [name, setName] = useState('');
  const [port, setPort] = useState('');
  const [error, setError] = useState('');

  const [createGateway, { loading }] = useMutation<CreateGatewayMutation>(
    CREATE_GATEWAY,
    {
      refetchQueries: [{ query: GET_GATEWAYS, variables: { controllerId } }],
      onCompleted: () => onClose(),
      onError: (err) => setError(err.message),
    },
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      setError('仅支持字母、数字、中划线和下划线');
      return;
    }
    if (name.length < 1 || name.length > 50) {
      setError('名称长度 1-50 字符');
      return;
    }

    const portNum = parseInt(port, 10);
    if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
      setError('端口范围: 1-65535');
      return;
    }
    createGateway({ variables: { controllerId, name, port: portNum } });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-80 rounded-lg bg-popover p-4 shadow-lg">
        <h3 className="mb-3 text-sm font-medium text-popover-foreground">新建网关暴露</h3>
        <form onSubmit={handleSubmit}>
          <input
            type="text"
            placeholder="服务名称 (如 my-api)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mb-2 w-full rounded border border-input bg-background px-3 py-1.5 text-sm text-foreground placeholder-muted-foreground focus:border-ring focus:outline-none"
            autoFocus
          />
          <input
            type="number"
            min={1}
            max={65535}
            placeholder="端口号 (1-65535)"
            value={port}
            onChange={(e) => setPort(e.target.value)}
            className="mb-2 w-full rounded border border-input bg-background px-3 py-1.5 text-sm text-foreground placeholder-muted-foreground focus:border-ring focus:outline-none"
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
