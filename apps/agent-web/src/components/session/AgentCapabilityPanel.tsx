import type { AgentCapabilitySnapshotData, AgentFeatureStatus, SessionData } from '../../graphql/types';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';

const FEATURE_LABELS: Record<string, string> = {
  'session.load': '会话加载（带历史重放）',
  'session.resume': '会话恢复（继续）',
  'session.close': '会话关闭',
  'session.list': '历史会话列表',
  'session.delete': '历史会话删除',
  'session.fork': '会话分叉（Fork）',
  'session.additionalDirectories': '附加工作目录',
  'prompt.image': '图片输入',
  'prompt.audio': '音频输入',
  'prompt.embeddedContext': '嵌入式上下文',
  'auth.login': 'Agent 认证登录',
  'auth.logout': 'Agent 认证登出',
  'mcp.http': 'MCP over HTTP',
  'mcp.sse': 'MCP over SSE',
  'config.boolean': '布尔配置项',
  'config.model': '模型切换',
  'config.mode': '模式切换',
  commands: '命令集（斜杠命令）',
  'elicitation.form': '问询：表单模式',
  'elicitation.url': '问询：链接模式',
};

const FEATURE_ORDER = [
  'session.load',
  'session.resume',
  'session.close',
  'session.list',
  'session.delete',
  'session.fork',
  'session.additionalDirectories',
  'prompt.image',
  'prompt.audio',
  'prompt.embeddedContext',
  'auth.login',
  'auth.logout',
  'mcp.http',
  'mcp.sse',
  'config.boolean',
  'config.model',
  'config.mode',
  'commands',
  'elicitation.form',
  'elicitation.url',
];

const STATUS_META: Record<AgentFeatureStatus, { label: string; className: string }> = {
  supported: { label: '支持', className: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' },
  partial: { label: '部分支持', className: 'bg-amber-500/10 text-amber-600 dark:text-amber-400' },
  unsupported: { label: '不支持', className: 'bg-muted text-muted-foreground' },
};

interface AgentCapabilityPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session: SessionData | null | undefined;
}

function snapshotOf(session: SessionData | null | undefined): AgentCapabilitySnapshotData | null {
  if (!session?.agentCapabilities) return null;
  return session.agentCapabilities;
}

export function AgentCapabilityPanel({ open, onOpenChange, session }: AgentCapabilityPanelProps) {
  const snapshot = snapshotOf(session);
  const features = session?.features ?? snapshot?.features ?? [];
  const hasSnapshot = features.length > 0;
  const agentName = snapshot?.agentInfo?.name ?? session?.agentInfo?.name ?? null;
  const agentVersion = snapshot?.agentInfo?.version ?? session?.agentInfo?.version ?? null;
  const agentLabel = agentName
    ? `${agentName}${agentVersion ? ` ${agentVersion}` : ''}`
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>能力清单</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          {agentLabel && (
            <p className="text-sm text-muted-foreground" data-testid="agent-capability-agent">
              Agent：{agentLabel}
            </p>
          )}

          {!hasSnapshot ? (
            <p className="text-sm text-muted-foreground" data-testid="agent-capability-empty">
              该会话创建于能力快照上线前，继续会话后可获取能力清单。
            </p>
          ) : (
            <ul className="space-y-1" data-testid="agent-capability-list">
              {FEATURE_ORDER.map((id) => {
                const feature = features.find((item) => item.id === id);
                const status = feature?.status ?? 'partial';
                const meta = STATUS_META[status];
                return (
                  <li
                    key={id}
                    data-testid={`agent-capability-row-${id}`}
                    className="flex items-start justify-between gap-3 rounded-md border border-border px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground">
                        {FEATURE_LABELS[id] ?? id}
                      </p>
                      <p className="text-xs text-muted-foreground font-mono">{id}</p>
                      {feature?.detail && (
                        <p className="mt-0.5 text-xs text-muted-foreground">{feature.detail}</p>
                      )}
                    </div>
                    <span
                      data-testid={`agent-capability-status-${id}`}
                      className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${meta.className}`}
                    >
                      {meta.label}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
