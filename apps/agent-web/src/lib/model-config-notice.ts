import { toast } from 'sonner'

/**
 * 模型/供应商变更成功后的统一提醒文案（单一来源，D18）。
 *
 * 用户侧模型/供应商 mutation 成功时服务端会 best-effort 把最新模型清单下发到运行中的云电脑，
 * 但部分 Harness 运行时不会重载模型配置，需提醒用户已运行会话可能要重启后生效。
 */
export const MODEL_CONFIG_APPLIED_NOTICE =
  '已保存并下发到运行中的云电脑；部分 Harness 运行时不会重载模型配置，已运行的会话可能需要重启后生效'

/** 提示「已下发到云电脑」（测试可直接 spy 本函数）。 */
export function notifyModelConfigApplied(): void {
  toast.success(MODEL_CONFIG_APPLIED_NOTICE)
}
