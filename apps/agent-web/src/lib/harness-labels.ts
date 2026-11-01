/**
 * Harness（ACP Server）类型 → 展示名映射。
 * 自 `SessionHeader.acpServerTypeLabels` 逐字迁移，供会话头、工作流节点卡片等共用；
 * 未识别的类型回退原值（不隐藏）。
 */
export const HARNESS_LABELS: Record<string, string> = {
  opencode: 'OpenCode',
  github_copilot: 'GitHub Copilot',
  claude_code: 'Claude Code',
  gemini_cli: 'Gemini CLI',
  codex: 'Codex',
  mimo_code: 'MiMo Code',
  kimi_code: 'Kimi Code',
  deepseek_harness: 'DeepSeek Harness',
}

export function harnessLabel(type?: string | null): string {
  if (!type) return ''
  return HARNESS_LABELS[type] ?? type
}
