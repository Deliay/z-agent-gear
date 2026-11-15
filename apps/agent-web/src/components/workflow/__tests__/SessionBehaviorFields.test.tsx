import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { useState } from 'react'
import { SessionBehaviorFields } from '../WorkflowGraphEditor'
import { emptySessionBehavior, type SessionBehaviorForm } from '../template-validation'
import type { WorkflowNodeType } from '@/graphql/workflow'

/** 受控包装：真实消费 onChange 补丁，便于断言「切到新会话后勾选被重置」 */
function Harness({
  nodeType = 'AI',
  initial,
}: {
  nodeType?: WorkflowNodeType
  initial?: Partial<SessionBehaviorForm>
}) {
  const [value, setValue] = useState<SessionBehaviorForm>({
    ...emptySessionBehavior(),
    ...initial,
  })
  return (
    <SessionBehaviorFields
      nodeType={nodeType}
      nodeName="评审"
      value={value}
      readOnly={false}
      onChange={(patch) => setValue((prev) => ({ ...prev, ...patch }))}
    />
  )
}

describe('SessionBehaviorFields（T-SB-WEB1）', () => {
  it('AI 节点渲染「会话行为」区与两组单选', () => {
    render(<Harness />)
    expect(screen.getByTestId('session-behavior-fields')).toBeInTheDocument()
    expect(screen.getByText('会话行为')).toBeInTheDocument()
    expect(screen.getByRole('radiogroup', { name: '评审 返工时会话行为' })).toBeInTheDocument()
    expect(screen.getByRole('radiogroup', { name: '评审 打回后会话行为' })).toBeInTheDocument()
    // 默认：返工时=原始会话 / 打回后=新会话（=服务端现状）
    expect(screen.getByLabelText('评审 返工时 原始会话')).toBeChecked()
    expect(screen.getByLabelText('评审 打回后 新会话')).toBeChecked()
  })

  it.each<WorkflowNodeType>(['HUMAN', 'FLAG'])('%s 节点不渲染会话行为区', (nodeType) => {
    render(<Harness nodeType={nodeType} />)
    expect(screen.queryByTestId('session-behavior-fields')).not.toBeInTheDocument()
    expect(screen.queryByText('会话行为')).not.toBeInTheDocument()
  })
})

describe('SessionBehaviorFields（T-SB-WEB2）', () => {
  it('返工时选「原始会话」展示压缩勾选，切回「新会话」隐藏并重置 false', () => {
    render(
      <Harness
        initial={{ reworkSessionBehavior: 'ORIGINAL_SESSION', reworkCompactOriginalContext: true }}
      />,
    )

    const checkbox = screen.getByLabelText('评审 返工时压缩原始上下文')
    expect(checkbox).toBeInTheDocument()
    expect(checkbox).toBeChecked()

    fireEvent.click(screen.getByLabelText('评审 返工时 新会话'))
    expect(screen.queryByLabelText('评审 返工时压缩原始上下文')).not.toBeInTheDocument()

    // 切回「原始会话」时勾选已被重置为 false
    fireEvent.click(screen.getByLabelText('评审 返工时 原始会话'))
    expect(screen.getByLabelText('评审 返工时压缩原始上下文')).not.toBeChecked()
  })

  it('打回后选「原始会话」展示压缩勾选，切回「新会话」隐藏并重置 false', () => {
    render(<Harness />)

    // 默认「新会话」不展示勾选
    expect(screen.queryByLabelText('评审 打回后压缩原始上下文')).not.toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('评审 打回后 原始会话'))
    fireEvent.click(screen.getByLabelText('评审 打回后压缩原始上下文'))
    expect(screen.getByLabelText('评审 打回后压缩原始上下文')).toBeChecked()

    fireEvent.click(screen.getByLabelText('评审 打回后 新会话'))
    expect(screen.queryByLabelText('评审 打回后压缩原始上下文')).not.toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('评审 打回后 原始会话'))
    expect(screen.getByLabelText('评审 打回后压缩原始上下文')).not.toBeChecked()
  })

  it('只读时单选与勾选均禁用', () => {
    const onChange = vi.fn()
    render(
      <SessionBehaviorFields
        nodeType="AI"
        nodeName="评审"
        value={{ ...emptySessionBehavior(), reworkSessionBehavior: 'ORIGINAL_SESSION' }}
        readOnly
        onChange={onChange}
      />,
    )
    expect(screen.getByLabelText('评审 返工时 新会话')).toBeDisabled()
    expect(screen.getByLabelText('评审 返工时压缩原始上下文')).toBeDisabled()
  })
})
