import { describe, expect, it } from 'vitest'
import {
  TABLE_ACTION_CELL_CLASS,
  TABLE_CELL_CLASS,
  TABLE_CELL_NUMERIC_CLASS,
  TABLE_HEAD_CELL_ACTION_CLASS,
  TABLE_HEAD_CELL_CLASS,
  TABLE_HEAD_CELL_NUMERIC_CLASS,
  TABLE_HEAD_CLASS,
  TABLE_ROW_CLASS,
} from '../table-styles'

describe('表格样式常量', () => {
  it('T-AUI-TB1: 表头/单元格/操作列符合规范 §6 场景 I', () => {
    expect(TABLE_HEAD_CLASS).toContain('text-xs font-medium text-muted-foreground bg-muted/40')
    expect(TABLE_HEAD_CELL_CLASS).toContain('text-xs font-medium text-muted-foreground')
    expect(TABLE_CELL_CLASS).toContain('text-sm py-2.5 px-3')
    expect(TABLE_CELL_NUMERIC_CLASS).toContain('tabular-nums')
    expect(TABLE_CELL_NUMERIC_CLASS).toContain('text-right')
    expect(TABLE_ACTION_CELL_CLASS).toContain('text-right')
    expect(TABLE_HEAD_CELL_ACTION_CLASS).toContain('text-right')
    expect(TABLE_HEAD_CELL_ACTION_CLASS).toContain('py-2.5 px-3')
    expect(TABLE_HEAD_CELL_NUMERIC_CLASS).toContain('text-right')
    expect(TABLE_ROW_CLASS).toContain('border-t')
  })
})
