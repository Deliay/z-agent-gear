import { useMutation } from '@apollo/client/react';
import { useState } from 'react';
import { DELETE_GATEWAY } from '../graphql/mutations';
import { HOME_OVERVIEW } from '../graphql/home';
import type { DeleteGatewayMutation, GatewayData } from '../graphql/types';
import { Copy, Trash2, Check } from 'lucide-react';

interface GatewayItemProps {
  gateway: GatewayData;
  controllerId: string;
}

export default function GatewayItem({ gateway, controllerId }: GatewayItemProps) {
  const [deleteGateway] = useMutation<DeleteGatewayMutation>(DELETE_GATEWAY, {
    refetchQueries: [{ query: HOME_OVERVIEW }],
  });
  const [copied, setCopied] = useState(false);

  // 地址唯一来源：服务端派生字段（PUBLIC_BASE_URL 单一来源），前端不得自行拼接。
  // 旧缓存/降级缺失时展示空并禁用复制（不拼假地址，计划 D6）。
  const accessUrl = gateway.endpoint ?? '';

  const handleCopy = async () => {
    if (!accessUrl) return;
    await navigator.clipboard.writeText(accessUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDelete = () => {
    deleteGateway({
      variables: { controllerId, name: gateway.name },
    });
  };

  return (
    <li className="flex items-center gap-2 rounded px-3 py-1.5 text-sm text-sidebar-foreground hover:bg-sidebar-accent">
      <span className="flex-1 truncate">{gateway.name}</span>
      <span className="text-xs text-muted-foreground">:{gateway.port}</span>
      <span
        className={`text-xs ${
          gateway.status === 'active' ? 'text-success-text' : 'text-muted-foreground'
        }`}
      >
        {gateway.status}
      </span>
      {gateway.status === 'active' && (
        <button
          type="button"
          onClick={handleCopy}
          disabled={!accessUrl}
          className="text-xs text-muted-foreground hover:text-sidebar-foreground disabled:cursor-not-allowed disabled:opacity-40"
          title={copied ? '已复制' : accessUrl || '暂无访问地址'}
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
        </button>
      )}
      <button
        type="button"
        onClick={handleDelete}
        className="text-xs text-destructive-text hover:text-destructive-text/80"
        title="删除网关暴露"
      >
        <Trash2 className="size-3" />
      </button>
    </li>
  );
}
