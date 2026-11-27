/**
 * 管理后台高密度表格样式常量（UI 规范 §6 场景 I）。
 *
 * 采用「样式常量 + 既有 JSX 结构微调」统一表格，不抽象通用 DataTable 组件；
 * 业务表格引用这些常量即可保证表头、行密度与操作列口径一致。
 */

export const TABLE_CONTAINER_CLASS = 'overflow-x-auto rounded-lg border'

export const TABLE_CLASS = 'w-full min-w-0 text-sm'

/** 表头行：12px 辅助字号 + 微量底色，保证高信息密度下的层次。 */
export const TABLE_HEAD_CLASS = 'text-xs font-medium text-muted-foreground bg-muted/40'

export const TABLE_HEAD_CELL_CLASS = 'text-xs font-medium text-muted-foreground py-2.5 px-3 text-left'

export const TABLE_HEAD_CELL_NUMERIC_CLASS =
  'text-xs font-medium text-muted-foreground py-2.5 px-3 text-right'

export const TABLE_ROW_CLASS = 'border-t transition-colors hover:bg-muted/40'

export const TABLE_CELL_CLASS = 'text-sm py-2.5 px-3'

export const TABLE_CELL_MUTED_CLASS = `${TABLE_CELL_CLASS} text-muted-foreground`

export const TABLE_CELL_NUMERIC_CLASS = `${TABLE_CELL_CLASS} text-right tabular-nums`

export const TABLE_CELL_STRONG_CLASS = `${TABLE_CELL_CLASS} font-medium text-foreground`

/** 操作列统一靠右，行内按钮使用 `Button size="sm" variant="ghost"`。 */
export const TABLE_ACTION_CELL_CLASS = 'py-2.5 px-3 text-right'

export const TABLE_ACTION_CLASS = 'flex items-center justify-end gap-1'
