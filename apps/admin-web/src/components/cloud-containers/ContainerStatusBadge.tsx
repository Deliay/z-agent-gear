import { Badge } from '@/components/ui/badge';
import type { CloudContainerStatus } from '@/graphql/types';
import { CONTAINER_STATUS_LABELS } from './labels';

type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline';

const STATUS_VARIANTS: Record<CloudContainerStatus, BadgeVariant> = {
  CREATING: 'secondary',
  CONNECTING: 'secondary',
  ONLINE: 'default',
  DESTROYING: 'secondary',
  EXITED: 'outline',
  FAILED: 'destructive',
};

interface ContainerStatusBadgeProps {
  status: CloudContainerStatus;
}

export default function ContainerStatusBadge({ status }: ContainerStatusBadgeProps) {
  return <Badge variant={STATUS_VARIANTS[status]}>{CONTAINER_STATUS_LABELS[status]}</Badge>;
}
