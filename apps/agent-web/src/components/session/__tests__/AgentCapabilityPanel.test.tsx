import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AgentCapabilityPanel } from '../AgentCapabilityPanel';
import type { SessionData } from '../../../graphql/types';
import { AGENT_FEATURE_ORDER } from '../../../constants/agentFeatures';

function makeSession(features: SessionData['features'], agentInfo: SessionData['agentInfo'] = null): SessionData {
  return {
    id: 'sess-1',
    userId: 'user-1',
    controllerId: 'ctrl-1',
    controllerName: 'dev',
    acpServerType: 'opencode',
    status: 'idling',
    title: null,
    externalSessionId: null,
    cwd: null,
    worktreePath: null,
    worktreeBranch: null,
    createdAt: '2026-10-21T00:00:00.000Z',
    updatedAt: '2026-10-21T00:00:00.000Z',
    endedAt: null,
    // 旧会话（无快照）必须 agentCapabilities=null，与后端 features=[] / agentCapabilities=null 同口径
    agentCapabilities: features
      ? {
          protocolVersion: 1,
          agentInfo: { name: 'OpenCode', version: '2.0.31' },
          features,
        }
      : null,
    features,
    agentInfo,
  };
}

const featureIds = AGENT_FEATURE_ORDER;

describe('AgentCapabilityPanel', () => {
  it('T-W4: 渲染固定顺序的能力行、状态徽标、detail 与 Agent 版本', () => {
    // 唯一事实源固定 20 项（集合断言）
    expect(new Set(AGENT_FEATURE_ORDER).size).toBe(20);
    const features = featureIds.map((id) => ({
      id,
      status: id === 'prompt.audio' ? 'unsupported' as const : 'supported' as const,
      detail: id === 'prompt.audio' ? '未声明 agentCapabilities.promptCapabilities.audio' : null,
    }));

    render(
      <AgentCapabilityPanel open onOpenChange={vi.fn()} session={makeSession(features)} />,
    );

    const rows = screen.getAllByTestId(/agent-capability-row-/);
    expect(rows).toHaveLength(20);
    // 顺序断言（名实相符）：DOM 顺序必须与唯一事实源 FEATURE_IDS 一致
    expect(rows.map((row) => row.getAttribute('data-testid')?.replace('agent-capability-row-', '')))
      .toEqual(featureIds);
    expect(screen.getByTestId('agent-capability-row-session.load')).toBeDefined();
    expect(screen.getByText('Agent：OpenCode 2.0.31')).toBeDefined();
    expect(screen.getByTestId('agent-capability-row-prompt.audio').textContent).toContain('不支持');
    expect(screen.getByTestId('agent-capability-row-prompt.audio').textContent).toContain('未声明');
  });

  it('T-W5: 无快照时显示旧会话提示，不渲染状态列表', () => {
    render(
      <AgentCapabilityPanel open onOpenChange={vi.fn()} session={makeSession(undefined)} />,
    );

    expect(screen.getByTestId('agent-capability-empty').textContent).toContain('创建于能力快照上线前');
    expect(screen.queryByTestId('agent-capability-list')).toBeNull();
  });
});
