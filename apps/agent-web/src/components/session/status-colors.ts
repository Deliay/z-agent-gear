export const STATUS_COLORS = {
  creating:     { dot: 'bg-warning animate-pulse', badge: 'bg-warning/15 text-warning-foreground' },
  connecting:   { dot: 'bg-warning animate-pulse', badge: 'bg-warning/15 text-warning-foreground' },
  idling:       { dot: 'bg-success',               badge: 'bg-success/15 text-success-foreground' },
  running:      { dot: 'bg-info animate-pulse',     badge: 'bg-info/15 text-info-foreground animate-pulse' },
  disconnected: { dot: 'bg-destructive',            badge: 'bg-destructive/15 text-destructive' },
  ended:        { dot: 'bg-muted-foreground',        badge: 'bg-muted text-muted-foreground' },
} as const;

export const STATUS_LABELS: Record<string, string> = {
  creating: '创建中',
  connecting: '连接中',
  idling: '空闲',
  running: '工作中',
  disconnected: '已断连',
  ended: '已结束',
};

export function getStatusDotColor(status: string): string {
  return STATUS_COLORS[status as keyof typeof STATUS_COLORS]?.dot ?? 'bg-muted-foreground';
}

export function getStatusBadgeClass(status: string): string {
  return STATUS_COLORS[status as keyof typeof STATUS_COLORS]?.badge ?? 'bg-muted text-muted-foreground';
}
