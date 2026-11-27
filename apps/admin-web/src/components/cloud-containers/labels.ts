import type {
  CloudContainerPurpose,
  CloudContainerStatus,
  CloudWorkloadLogPhase,
  CloudWorkloadLogStatus,
  CloudWorkloadParamType,
} from '@/graphql/types';
import { statusLabel } from '@/lib/status-labels';

// 状态展示映射（裁决 18：内部 initializing ↔ GraphQL INITIALIZING ↔ 前端「初始化中」）
// 文案与徽标变体的单一来源为 `lib/status-labels.ts`，此处仅保留类型化的转发薄层。
export const CONTAINER_STATUS_LABELS: Record<CloudContainerStatus, string> = {
  CREATING: statusLabel('CREATING'),
  CONNECTING: statusLabel('CONNECTING'),
  INITIALIZING: statusLabel('INITIALIZING'),
  ONLINE: statusLabel('ONLINE'),
  DESTROYING: statusLabel('DESTROYING'),
  EXITED: statusLabel('EXITED'),
  FAILED: statusLabel('FAILED'),
};

// 用途展示映射（本期启动仅 IDLE）
export const CONTAINER_PURPOSE_LABELS: Record<CloudContainerPurpose, string> = {
  IDLE: 'idle',
  ADMIN_TASK: '后台任务',
  WORKFLOW: '工作流',
  SESSION: '独立会话',
};

// 工作负载执行阶段映射（裁决 18：INIT/POST → 初始化/清理）
export const WORKLOAD_LOG_PHASE_LABELS: Record<CloudWorkloadLogPhase, string> = {
  INIT: '初始化',
  POST: '清理',
};

// 工作负载执行状态映射（裁决 18）
export const WORKLOAD_LOG_STATUS_LABELS: Record<CloudWorkloadLogStatus, string> = {
  PENDING: statusLabel('PENDING'),
  RUNNING: statusLabel('RUNNING'),
  SUCCESS: statusLabel('SUCCESS'),
  FAILED: statusLabel('FAILED'),
  TIMEOUT: statusLabel('TIMEOUT'),
};

// 参数类型映射（功能点 1：下拉单选/下拉多选/文本/布尔）
export const PARAM_TYPE_LABELS: Record<CloudWorkloadParamType, string> = {
  SELECT: '下拉单选',
  MULTI_SELECT: '下拉多选',
  TEXT: '文本',
  BOOLEAN: '布尔',
};

// 「必须」工作负载标识（工作负载三期，功能点 4）：启动选择/顺序预览/执行日志共用
export const REQUIRED_LABEL = '必须';
// 启动对话框「必须」开关的一行说明（PRD §3.4）
export const REQUIRED_HINT = '标记为必须的工作负载初始化失败将导致容器被强制注销。';
