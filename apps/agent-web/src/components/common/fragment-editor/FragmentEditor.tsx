import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery } from '@apollo/client/react'
import { GET_VALUT_MANUAL_OPTIONS } from '@/graphql/queries'
import type { GetValutManualOptionsQuery } from '@/graphql/types'
import {
  fragmentsToNodes,
  nodesToFragments,
  refDisplay,
  formatForEditorMode,
  type EditorNode,
  type Fragment,
} from '@/lib/fragment-editor'

export interface FragmentEditorProps {
  value: Fragment[]
  onChange: (value: Fragment[]) => void
  /** 单行（拦截 Enter 与粘贴换行）/ 多行 */
  mode?: 'single' | 'multi'
  /** 新插入引用节点的格式：Generic / Json / Uri */
  editorMode?: 'Generic' | 'Json' | 'Uri'
  /** `$` 补全数据源：参数标识 → 展示信息 */
  params?: Record<string, { name: string; description?: string }>
  placeholder?: string
  disabled?: boolean
  ariaLabel?: string
  className?: string
}

type Completions =
  | { kind: 'Parameter' }
  | { kind: 'Valut' }

const CHIP_BASE =
  'mx-0.5 inline-flex max-w-full items-center gap-1 rounded px-1.5 py-0.5 align-middle text-xs font-medium'

function chipClass(type: 'Valut' | 'Parameter'): string {
  return type === 'Valut'
    ? `${CHIP_BASE} bg-emerald-500/15 text-emerald-700 dark:text-emerald-300`
    : `${CHIP_BASE} bg-sky-500/15 text-sky-700 dark:text-sky-300`
}

function formatBadge(format: string): string | null {
  return format === 'Json' ? 'JSON' : format === 'Uri' ? 'URI' : null
}

function createChip(type: 'Valut' | 'Parameter', value: string, format: string): HTMLElement {
  const chip = document.createElement('span')
  chip.setAttribute('contenteditable', 'false')
  chip.setAttribute('data-fragment-type', type)
  chip.setAttribute('data-fragment-value', value)
  chip.setAttribute('data-fragment-format', format)
  chip.className = chipClass(type)
  chip.textContent = refDisplay(type, value)
  const badge = formatBadge(format)
  if (badge) {
    const tag = document.createElement('span')
    tag.className = 'rounded bg-background/60 px-1 text-[10px] uppercase'
    tag.textContent = badge
    chip.appendChild(tag)
  }
  return chip
}

/** 递归读取 contentEditable DOM 为节点序列（chip → 引用节点，文本节点 → 文本）。 */
function readNodes(root: HTMLElement): EditorNode[] {
  const nodes: EditorNode[] = []
  const pushText = (text: string) => {
    const cleaned = text.replace(/\u200b/g, '')
    if (!cleaned) return
    const last = nodes[nodes.length - 1]
    if (last?.kind === 'text') last.text += cleaned
    else nodes.push({ kind: 'text', text: cleaned })
  }

  const walk = (parent: Node) => {
    parent.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        pushText(child.textContent ?? '')
        return
      }
      if (child.nodeType !== Node.ELEMENT_NODE) return
      const element = child as HTMLElement
      const type = element.getAttribute('data-fragment-type')
      if (type === 'Valut' || type === 'Parameter') {
        nodes.push({
          kind: 'ref',
          type,
          value: element.getAttribute('data-fragment-value') ?? '',
          format: (element.getAttribute('data-fragment-format') ?? 'Generic') as Fragment['format'],
        })
        return
      }
      if (element.tagName === 'BR') {
        pushText('\n')
        return
      }
      walk(element)
    })
  }

  walk(root)
  return nodes
}

function sameFragments(a: Fragment[], b: Fragment[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * 可复用 Fragment 模板编辑器（contentEditable + 原子引用块，计划 Phase 4 / 提案 D4）。
 *
 * - Plain → 文本节点；Valut/Parameter → `contentEditable=false` 原子 chip（不同配色 + 格式角标）；
 * - `$` 触发参数补全（仅已声明 params）、`#` 触发 Valut 补全（仅 manual 名单，`GET_VALUT_MANUAL_OPTIONS`）；
 * - IME 组合期间不触发补全；单行模式拦截 Enter 与粘贴换行；
 * - **不求值红线**：本组件只展示引用名，任何状态不请求/不展示密钥值。
 */
export default function FragmentEditor({
  value,
  onChange,
  mode = 'multi',
  editorMode = 'Generic',
  params = {},
  placeholder,
  disabled = false,
  ariaLabel,
  className,
}: FragmentEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const lastEmittedRef = useRef<Fragment[]>(value)
  const pendingRangeRef = useRef<Range | null>(null)
  const composingRef = useRef(false)
  const [completions, setCompletions] = useState<Completions | null>(null)
  const [highlighted, setHighlighted] = useState(0)

  const { data: valutData } = useQuery<GetValutManualOptionsQuery>(GET_VALUT_MANUAL_OPTIONS, {
    skip: completions?.kind !== 'Valut',
    fetchPolicy: 'cache-and-network',
  })

  const renderValue = useCallback((fragments: Fragment[]) => {
    const container = containerRef.current
    if (!container) return
    container.innerHTML = ''
    for (const node of fragmentsToNodes(fragments)) {
      if (node.kind === 'text') {
        container.appendChild(document.createTextNode(node.text))
      } else {
        container.appendChild(createChip(node.type, node.value, node.format))
      }
    }
  }, [])

  useEffect(() => {
    if (sameFragments(value, lastEmittedRef.current)) return
    lastEmittedRef.current = value
    renderValue(value)
  }, [value, renderValue])

  useEffect(() => {
    renderValue(value)
    lastEmittedRef.current = value
    // 仅首次挂载渲染（后续由 value 变化驱动）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const emit = useCallback(() => {
    const container = containerRef.current
    if (!container) return
    const fragments = nodesToFragments(readNodes(container))
    lastEmittedRef.current = fragments
    onChange(fragments)
  }, [onChange])

  const insertText = useCallback(
    (text: string) => {
      const selection = window.getSelection()
      if (!selection || selection.rangeCount === 0) return
      const range = selection.getRangeAt(0)
      range.deleteContents()
      const node = document.createTextNode(text)
      range.insertNode(node)
      range.setStartAfter(node)
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
      emit()
    },
    [emit],
  )

  const insertRef = useCallback(
    (type: 'Valut' | 'Parameter', refValue: string) => {
      const container = containerRef.current
      if (!container) return
      const selection = window.getSelection()
      const range =
        pendingRangeRef.current ??
        (selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null)
      if (!range) return

      range.deleteContents()
      const chip = createChip(type, refValue, formatForEditorMode(editorMode))
      const spacer = document.createTextNode('\u200b')
      range.insertNode(spacer)
      range.insertNode(chip)
      range.setStartAfter(spacer)
      range.collapse(true)
      selection?.removeAllRanges()
      selection?.addRange(range)
      pendingRangeRef.current = null
      setCompletions(null)
      container.focus()
      emit()
    },
    [editorMode, emit],
  )

  const parameterOptions = Object.entries(params).map(([key, info]) => ({
    value: key,
    label: info.name,
    description: info.description,
  }))
  const valutOptions = (valutData?.valutManualOptions ?? []).map((entry) => ({
    value: entry.key,
    label: entry.key,
    description: entry.namespaceDisplayName,
  }))
  const options = completions?.kind === 'Valut' ? valutOptions : parameterOptions

  const openCompletions = (kind: 'Valut' | 'Parameter') => {
    const selection = window.getSelection()
    pendingRangeRef.current =
      selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null
    setHighlighted(0)
    setCompletions({ kind })
  }

  const handleBeforeInput = (event: React.FormEvent<HTMLDivElement>) => {
    if (disabled) return
    const inputEvent = event.nativeEvent as InputEvent
    const data = inputEvent.data
    if (composingRef.current) return
    if (data === '$') {
      event.preventDefault()
      openCompletions('Parameter')
      return
    }
    if (data === '#') {
      event.preventDefault()
      openCompletions('Valut')
      return
    }
    if (mode === 'single' && data && data.includes('\n')) {
      event.preventDefault()
      insertText(data.replace(/\n/g, ' '))
    }
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!completions && (event.key === '$' || event.key === '#')) {
      event.preventDefault()
      openCompletions(event.key === '#' ? 'Valut' : 'Parameter')
      return
    }
    if (completions) {
      if (event.key === 'Escape') {
        event.preventDefault()
        setCompletions(null)
        return
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setHighlighted((index) => Math.min(index + 1, Math.max(options.length - 1, 0)))
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setHighlighted((index) => Math.max(index - 1, 0))
        return
      }
      if (event.key === 'Enter' && options[highlighted]) {
        event.preventDefault()
        insertRef(completions.kind, options[highlighted].value)
        return
      }
    }
    if (mode === 'single' && event.key === 'Enter') {
      event.preventDefault()
      return
    }
    if (event.key === 'Backspace' && removeChipBeforeCaret()) {
      event.preventDefault()
      emit()
    }
  }

  /** 退格在 chip 边界整体删除（原子引用块不可块内编辑）。 */
  const removeChipBeforeCaret = (): boolean => {
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return false
    const range = selection.getRangeAt(0)
    const node = range.startContainer
    if (!node) return false

    let chip: HTMLElement | null = null
    if (node.nodeType === Node.TEXT_NODE) {
      if (range.startOffset !== 0) return false
      chip = node.previousSibling as HTMLElement | null
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const before = (node as HTMLElement).childNodes[range.startOffset - 1]
      chip = (before as HTMLElement) ?? null
    }
    if (!chip || !chip.getAttribute?.('data-fragment-type')) return false

    const parent = chip.parentNode
    const next = chip.nextSibling
    chip.remove()
    if (next && next.nodeType === Node.TEXT_NODE) {
      const text = next as Text
      const caret = document.createRange()
      caret.setStart(text, 0)
      caret.collapse(true)
      selection.removeAllRanges()
      selection.addRange(caret)
    } else if (parent) {
      const caret = document.createRange()
      caret.selectNodeContents(parent)
      caret.collapse(false)
      selection.removeAllRanges()
      selection.addRange(caret)
    }
    return true
  }

  const handlePaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    if (mode !== 'single') return
    event.preventDefault()
    insertText(event.clipboardData.getData('text').replace(/\r?\n/g, ' '))
  }

  return (
    <div className={className}>
      <div className="relative">
        <div
          ref={containerRef}
          role="textbox"
          aria-label={ariaLabel}
          aria-multiline={mode === 'multi'}
          data-placeholder={placeholder}
          data-disabled={disabled ? 'true' : undefined}
          tabIndex={disabled ? -1 : 0}
          contentEditable={!disabled}
          suppressContentEditableWarning
          onInput={emit}
          onBeforeInput={handleBeforeInput}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onCompositionStart={() => {
            composingRef.current = true
          }}
          onCompositionEnd={() => {
            composingRef.current = false
          }}
          onBlur={() => {
            // 延迟关闭：允许鼠标点击补全项（点击前先 blur）
            window.setTimeout(() => setCompletions(null), 120)
          }}
          className={[
            'min-h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none',
            'empty:before:text-muted-foreground empty:before:content-[attr(data-placeholder)]',
            'focus:border-ring focus:ring-1 focus:ring-ring',
            mode === 'multi' ? 'min-h-24 whitespace-pre-wrap' : 'overflow-x-auto whitespace-nowrap',
            disabled ? 'cursor-not-allowed opacity-60' : '',
          ].join(' ')}
        />
        {completions ? (
          <div
            role="listbox"
            aria-label={completions.kind === 'Valut' ? 'Valut 密钥' : '参数'}
            className="absolute left-0 top-full z-50 mt-1 max-h-56 w-full min-w-0 overflow-auto rounded-md border border-border bg-popover p-1 shadow-md"
          >
            {options.length === 0 ? (
              <div className="px-2 py-1 text-xs text-muted-foreground">暂无可用项</div>
            ) : (
              options.map((option, index) => (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={index === highlighted}
                  className={`flex w-full min-w-0 items-center justify-between gap-2 rounded px-2 py-1 text-left text-sm ${
                    index === highlighted ? 'bg-accent text-accent-foreground' : ''
                  }`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => insertRef(completions.kind, option.value)}
                >
                  <span className="truncate font-medium">
                    {completions.kind === 'Valut' ? `#${option.label}` : `$${option.value}`}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {option.description ?? option.label}
                  </span>
                </button>
              ))
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}
