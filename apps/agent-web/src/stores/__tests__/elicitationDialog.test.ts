import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  getElicitationDraft,
  resetElicitationDialog,
  saveElicitationDraft,
  useElicitationDialogState,
} from '../elicitationDialog';
import type { TodoItemData } from '../../graphql/types';

const todo = {
  id: 'todo-1',
  type: 'elicitation_request',
  priority: 'immediate',
  title: 'Agent请求输入',
  description: null,
  isRead: false,
  data: null,
  elicitationData: {
    requestId: 'elic-1',
    sessionId: 'sess-1',
    toolCallId: null,
    mode: 'form',
    message: 'Need input',
    requestedSchema: { type: 'object', properties: {} },
    elicitationId: null,
    url: null,
  },
  createdAt: '2026-10-21T00:00:00.000Z',
} as TodoItemData;

describe('elicitationDialog store', () => {
  beforeEach(() => {
    resetElicitationDialog();
  });

  it('open 保存 todo 快照，列表移除后仍可取到', () => {
    const { result } = renderHook(() => useElicitationDialogState());

    act(() => result.current.open(todo, 'banner'));

    expect(result.current.todoId).toBe('todo-1');
    expect(result.current.owner).toBe('banner');
    expect(result.current.snapshot).toEqual(todo);
  });

  it('close(owner) 带持有方守卫：非持有方无法关闭', () => {
    const { result } = renderHook(() => useElicitationDialogState());
    act(() => result.current.open(todo, 'banner'));

    act(() => result.current.close('todo'));
    expect(result.current.todoId).toBe('todo-1');
    expect(result.current.owner).toBe('banner');

    act(() => result.current.close('banner'));
    expect(result.current.todoId).toBeNull();
    expect(result.current.owner).toBeNull();
    expect(result.current.snapshot).toBeNull();
  });

  it('N-5: 草稿 Map 上限 50，超限淘汰最旧', () => {
    for (let i = 0; i < 55; i += 1) saveElicitationDraft(`req-${i}`, { i });
    expect(getElicitationDraft('req-0')).toEqual({});
    expect(getElicitationDraft('req-4')).toEqual({});
    expect(getElicitationDraft('req-5')).toEqual({ i: 5 });
    expect(getElicitationDraft('req-54')).toEqual({ i: 54 });
  });

  it('N-6: sync 刷新快照终态，移除后仍可读取 accepted', () => {
    const { result } = renderHook(() => useElicitationDialogState());
    act(() => result.current.open(todo, 'todo'));
    act(() => result.current.sync({ ...todo, resolution: 'accepted' }));

    expect(result.current.snapshot?.resolution).toBe('accepted');
  });

  it('owner 切换（同一 todo）更新持有方并保留快照', () => {
    const { result } = renderHook(() => useElicitationDialogState());
    act(() => result.current.open(todo, 'todo'));
    act(() => result.current.open(todo, 'banner'));

    expect(result.current.owner).toBe('banner');
    expect(result.current.snapshot).toEqual(todo);
  });
});
