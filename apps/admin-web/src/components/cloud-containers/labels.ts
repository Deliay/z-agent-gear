import type { CloudContainerPurpose, CloudContainerStatus } from '@/graphql/types';

// 状态展示映射（裁决 4：创建中/连接中/在线/销毁中/已退出/失败）
export const CONTAINER_STATUS_LABELS: Record<CloudContainerStatus, string> = {
  CREATING: '创建中',
  CONNECTING: '连接中',
  ONLINE: '在线',
  DESTROYING: '销毁中',
  EXITED: '已退出',
  FAILED: '失败',
};

// 用途展示映射（本期启动仅 IDLE）
export const CONTAINER_PURPOSE_LABELS: Record<CloudContainerPurpose, string> = {
  IDLE: 'idle',
  ADMIN_TASK: '后台任务',
  WORKFLOW: '工作流',
  SESSION: '独立会话',
};
