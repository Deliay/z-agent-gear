export const STATUS_COLORS = {
  creating:     { dot: 'bg-yellow-500', badge: 'bg-yellow-100 text-yellow-800' },
  connecting:   { dot: 'bg-yellow-500', badge: 'bg-yellow-100 text-yellow-800' },
  idling:       { dot: 'bg-green-500',  badge: 'bg-green-100 text-green-800' },
  running:      { dot: 'bg-blue-500 animate-pulse',   badge: 'bg-blue-100 text-blue-800 animate-pulse' },
  disconnected: { dot: 'bg-orange-500', badge: 'bg-orange-100 text-orange-800' },
  ended:        { dot: 'bg-gray-500',   badge: 'bg-gray-100 text-gray-800' },
} as const;

export const STATUS_LABELS: Record<string, string> = {
  creating: 'Creating',
  connecting: 'Connecting',
  idling: 'Idle',
  running: 'Working',
  disconnected: 'Disconnected',
  ended: 'Ended',
};

export function getStatusDotColor(status: string): string {
  return STATUS_COLORS[status as keyof typeof STATUS_COLORS]?.dot ?? 'bg-gray-500';
}

export function getStatusBadgeClass(status: string): string {
  return STATUS_COLORS[status as keyof typeof STATUS_COLORS]?.badge ?? 'bg-gray-100 text-gray-800';
}
