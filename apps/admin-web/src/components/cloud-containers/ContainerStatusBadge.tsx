import { Badge } from '@/components/ui/badge';
import type { CloudContainerStatus } from '@/graphql/types';
import { statusBadgeProps } from '@/lib/status-labels';

interface ContainerStatusBadgeProps {
  status: CloudContainerStatus;
}

export default function ContainerStatusBadge({ status }: ContainerStatusBadgeProps) {
  const { label, variant } = statusBadgeProps(status);
  return <Badge variant={variant}>{label}</Badge>;
}
