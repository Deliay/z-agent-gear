/**
 * 状态徽标统一映射单一来源（UI 规范 §2.4 跨领域状态色矩阵）。
 *
 * 约定：
 * - 同一状态键恒返回同一 Badge 变体与文案；
 * - 未知键回落 `muted` 且不抛错，避免新增后端枚举导致页面崩溃；
 * - 业务组件通过本模块取映射，`components/cloud-containers/labels.ts` 与
 *   `components/tenants/roles.ts` 保留为转发薄层，避免大面积改 import。
 */

export type StatusBadgeVariant =
  | 'default'
  | 'secondary'
  | 'destructive'
  | 'success'
  | 'warning'
  | 'info'
  | 'muted'
  | 'outline'

export type StatusTone = 'primary' | 'success' | 'warning' | 'info' | 'destructive' | 'muted'

export interface StatusBadgeProps {
  label: string
  variant: StatusBadgeVariant
  tone: StatusTone
}

interface StatusMeta {
  label: string
  tone: StatusTone
}

const TONE_VARIANTS: Record<StatusTone, StatusBadgeVariant> = {
  primary: 'default',
  success: 'success',
  warning: 'warning',
  info: 'info',
  destructive: 'destructive',
  muted: 'muted',
}

/**
 * 规范 §2.4 状态色矩阵 + 后台各业务域枚举。
 * 键保持后端契约原样（大小写敏感），文案统一简体中文。
 */
const STATUS_META: Record<string, StatusMeta> = {
  // 云端容器
  CREATING: { label: '创建中', tone: 'warning' },
  CONNECTING: { label: '连接中', tone: 'warning' },
  INITIALIZING: { label: '初始化中', tone: 'warning' },
  ONLINE: { label: '在线', tone: 'success' },
  DESTROYING: { label: '销毁中', tone: 'warning' },
  EXITED: { label: '已退出', tone: 'muted' },
  FAILED: { label: '失败', tone: 'destructive' },
  // 工作负载执行日志
  PENDING: { label: '等待', tone: 'muted' },
  WAITING: { label: '等待', tone: 'muted' },
  RUNNING: { label: '执行中', tone: 'info' },
  SUCCESS: { label: '成功', tone: 'success' },
  TIMEOUT: { label: '超时', tone: 'warning' },
  // 计费账户 / 账单
  active: { label: '正常', tone: 'success' },
  frozen: { label: '已冻结', tone: 'warning' },
  insufficient: { label: '欠费', tone: 'destructive' },
  recharge: { label: '入账', tone: 'success' },
  charge: { label: '消费', tone: 'muted' },
  deduction: { label: '扣费', tone: 'muted' },
  refund: { label: '退款', tone: 'info' },
  adjust: { label: '调整', tone: 'warning' },
  abnormal: { label: '异常', tone: 'destructive' },
  pass: { label: '通过', tone: 'success' },
  error: { label: '差错', tone: 'destructive' },
  // 模型调用（契约 BillingApiCall.status：started | completed | aborted | failed）
  started: { label: '进行中/异常', tone: 'warning' },
  completed: { label: '完成', tone: 'success' },
  aborted: { label: '中断调用', tone: 'warning' },
  failed: { label: '失败', tone: 'destructive' },
  // 租户 / 成员 / 工作区
  personal: { label: '个人', tone: 'info' },
  team: { label: '团队', tone: 'primary' },
  admin: { label: '管理员', tone: 'primary' },
  developer: { label: '开发', tone: 'muted' },
  global: { label: '全局', tone: 'info' },
  normal: { label: '普通', tone: 'muted' },
  // 模型 / 供应商 / 认证
  enabled: { label: '启用', tone: 'success' },
  disabled: { label: '停用', tone: 'muted' },
  oidc: { label: 'OIDC', tone: 'info' },
  github_oauth: { label: 'GitHub', tone: 'primary' },
}

/** 返回状态徽标属性；未知状态回落 muted 并使用调用方提供的兜底文案。 */
export function statusBadgeProps(status: string | null | undefined, fallbackLabel?: string): StatusBadgeProps {
  if (!status) {
    return { label: fallbackLabel ?? '-', variant: TONE_VARIANTS.muted, tone: 'muted' }
  }
  const meta = STATUS_META[status]
  if (!meta) {
    return { label: fallbackLabel ?? status, variant: TONE_VARIANTS.muted, tone: 'muted' }
  }
  return { label: meta.label, variant: TONE_VARIANTS[meta.tone], tone: meta.tone }
}

/** 仅取状态文案，供 `<option>`/纯文本场景复用。 */
export function statusLabel(status: string | null | undefined, fallbackLabel?: string): string {
  return statusBadgeProps(status, fallbackLabel).label
}

/** 仅取 Badge 变体，供已有 Badge JSX 逐步迁移。 */
export function statusVariant(status: string | null | undefined): StatusBadgeVariant {
  return statusBadgeProps(status).variant
}
