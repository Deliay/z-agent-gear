import { useMutation } from '@apollo/client/react';
import { useState } from 'react';
import { DELETE_PORT_FORWARD } from '../graphql/mutations';
import { GET_PORT_FORWARDS } from '../graphql/queries';
import type { DeletePortForwardMutation, PortForwardData } from '../graphql/types';

interface PortForwardItemProps {
  portForward: PortForwardData;
  controllerId: string;
}

export default function PortForwardItem({ portForward, controllerId }: PortForwardItemProps) {
  const [deletePortForward] = useMutation<DeletePortForwardMutation>(DELETE_PORT_FORWARD, {
    refetchQueries: [{ query: GET_PORT_FORWARDS, variables: { controllerId } }],
  });
  const [copied, setCopied] = useState(false);

  const accessUrl = `${window.location.origin}/api/forward/${controllerId}/${portForward.port}/`;

  const handleCopy = async () => {
    await navigator.clipboard.writeText(accessUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDelete = () => {
    deletePortForward({
      variables: { controllerId, port: portForward.port },
    });
  };

  return (
    <li className="flex items-center gap-2 rounded px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-800">
      <span className="text-xs text-gray-400">↗</span>
      <span className="flex-1 truncate">:{portForward.port}</span>
      {portForward.status === 'active' && (
        <button
          type="button"
          onClick={handleCopy}
          className="text-xs text-blue-400 hover:text-blue-300"
          title={accessUrl}
        >
          {copied ? '已复制' : '复制链接'}
        </button>
      )}
      <span
        className={`text-xs ${
          portForward.status === 'active' ? 'text-green-400' : 'text-gray-500'
        }`}
      >
        {portForward.status}
      </span>
      <button
        type="button"
        onClick={handleDelete}
        className="text-xs text-red-400 hover:text-red-300"
        title="删除端口转发"
      >
        ✕
      </button>
    </li>
  );
}
