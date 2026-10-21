import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAgentCapabilities } from './useAgentCapabilities';
import type { SessionData } from '../graphql/types';

function session(features: SessionData['features']): SessionData {
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
    features,
  };
}

describe('useAgentCapabilities', () => {
  it('T-W1: 空清单（旧会话）不拦截', () => {
    const { result } = renderHook(() => useAgentCapabilities(session([])));
    expect(result.current.hasSnapshot).toBe(false);
    expect(result.current.isBlocked('prompt.image')).toBe(false);
    expect(result.current.status('prompt.image')).toBe('partial');
  });

  it('T-W2: unsupported 明确拦截', () => {
    const { result } = renderHook(() => useAgentCapabilities(session([
      { id: 'prompt.image', status: 'unsupported', detail: '未声明 agentCapabilities.promptCapabilities.image' },
    ])));
    expect(result.current.isBlocked('prompt.image')).toBe(true);
    expect(result.current.detail('prompt.image')).toContain('未声明');
  });

  it('T-W3: partial 放行', () => {
    const { result } = renderHook(() => useAgentCapabilities(session([
      { id: 'session.fork', status: 'partial', detail: '平台暂未提供入口' },
    ])));
    expect(result.current.isBlocked('session.fork')).toBe(false);
  });

  it('未提供 session 时全部放行', () => {
    const { result } = renderHook(() => useAgentCapabilities(null));
    expect(result.current.hasSnapshot).toBe(false);
    expect(result.current.isBlocked('config.model')).toBe(false);
  });
});
