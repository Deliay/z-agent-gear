import type {
  CloudContainerPurpose,
  CloudContainerStatus,
  CloudWorkloadLogPhase,
  CloudWorkloadLogStatus,
  CloudWorkloadParamType,
} from '@/graphql/types';

// 状态展示映射（裁决 18：内部 initializing ↔ GraphQL INITIALIZING ↔ 前端「初始化中」）
export const CONTAINER_STATUS_LABELS: Record<CloudContainerStatus, string> = {
  CREATING: '创建中',
  CONNECTING: '连接中',
  INITIALIZING: '初始化中',
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

// 工作负载执行阶段映射（裁决 18：INIT/POST → 初始化/清理）
export const WORKLOAD_LOG_PHASE_LABELS: Record<CloudWorkloadLogPhase, string> = {
  INIT: '初始化',
  POST: '清理',
};

// 工作负载执行状态映射（裁决 18）
export const WORKLOAD_LOG_STATUS_LABELS: Record<CloudWorkloadLogStatus, string> = {
  PENDING: '等待',
  RUNNING: '执行中',
  SUCCESS: '成功',
  FAILED: '失败',
  TIMEOUT: '超时',
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
