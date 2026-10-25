import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  resetHarnessLoginDialog,
  useHarnessLoginDialogState,
} from '../harnessLoginDialog';
import type { HarnessLoginRequestDataFields } from '../../graphql/types';

function request(requestId: string): HarnessLoginRequestDataFields {
  return {
    requestId,
    controllerId: 'ctrl-1',
    serverType: 'kimi_code',
    trigger: 'probe-options',
    url: `https://www.kimi.com/code/authorize_device?user_code=${requestId}`,
    userCode: requestId,
    expiresAt: '2026-10-25T12:30:00.000Z',
  };
}

describe('harnessLoginDialog store（T-W1）', () => {
  beforeEach(() => {
    resetHarnessLoginDialog();
  });

  it('首次 open 进入当前弹窗', () => {
    const { result } = renderHook(() => useHarnessLoginDialogState());
    act(() => result.current.open(request('hl-1')));
    expect(result.current.current?.requestId).toBe('hl-1');
    expect(result.current.queue).toHaveLength(0);
  });

  it('同 requestId 二次 open 幂等（不重复入队、快照更新）', () => {
    const { result } = renderHook(() => useHarnessLoginDialogState());
    act(() => result.current.open(request('hl-1')));
    const first = result.current.current;

    act(() => result.current.open(request('hl-1')));
    expect(result.current.current).toBe(first);

    act(() => result.current.open({ ...request('hl-1'), userCode: 'UPDATED' }));
    expect(result.current.current?.userCode).toBe('UPDATED');
    expect(result.current.queue).toHaveLength(0);
  });

  it('并发多请求只渲染一个，其余按序排队并出栈', () => {
    const { result } = renderHook(() => useHarnessLoginDialogState());
    act(() => result.current.open(request('hl-1')));
    act(() => result.current.open(request('hl-2')));
    act(() => result.current.open(request('hl-2')));

    expect(result.current.current?.requestId).toBe('hl-1');
    expect(result.current.queue.map((item) => item.requestId)).toEqual(['hl-2']);

    act(() => result.current.close());
    expect(result.current.current?.requestId).toBe('hl-2');
    expect(result.current.queue).toHaveLength(0);

    act(() => result.current.close());
    expect(result.current.current).toBeNull();
  });

  it('resolved 当前请求自动关闭并出栈下一个', () => {
    const { result } = renderHook(() => useHarnessLoginDialogState());
    act(() => result.current.open(request('hl-1')));
    act(() => result.current.open(request('hl-2')));

    act(() => {
      expect(result.current.resolve('hl-1')).toBe(true);
    });
    expect(result.current.current?.requestId).toBe('hl-2');
  });

  it('resolved 未命中的 requestId 不改变状态', () => {
    const { result } = renderHook(() => useHarnessLoginDialogState());
    act(() => result.current.open(request('hl-1')));

    act(() => {
      expect(result.current.resolve('hl-404')).toBe(false);
    });
    expect(result.current.current?.requestId).toBe('hl-1');
  });
});
