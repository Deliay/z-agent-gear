import { useEffect, useRef } from 'react';
import { getApiBase } from '../lib/api-base';
import type { HarnessLoginRequestDataFields } from '../graphql/types';
import type { HarnessLoginResolution } from '../stores/harnessLoginDialog';

export interface HarnessLoginResolvedEvent {
  requestId: string;
  result: HarnessLoginResolution;
  account?: string | null;
  error?: string | null;
}

interface UserSSEMessage {
  type: string;
  data?: unknown;
}

interface UseUserEventStreamOptions {
  enabled?: boolean;
  onHarnessLoginRequired?: (data: HarnessLoginRequestDataFields) => void;
  onHarnessLoginResolved?: (data: HarnessLoginResolvedEvent) => void;
  onReady?: () => void;
  /** 建连/解析异常（非致命，仍会按退避重连） */
  onError?: (error: unknown) => void;
}

const INITIAL_RETRY_MS = 1000;
const MAX_RETRY_MS = 30000;

/**
 * 用户级 SSE（GET /api/user/stream）：MainLayout 全局订阅，用于即时呈现登录引导弹窗。
 * 断线按指数退避重连（1s→30s），卸载时关闭连接并清理定时器。
 * `HOME_OVERVIEW` 的待办轮询保留为兜底（SSE 漏事件时 ≤15s 内仍能打开弹窗）。
 */
export function useUserEventStream(options: UseUserEventStreamOptions): void {
  const { enabled = true } = options;
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  useEffect(() => {
    if (!enabled) return;
    if (typeof EventSource === 'undefined') return;

    let closed = false;
    let retries = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let source: EventSource | null = null;

    const clearTimer = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const connect = () => {
      if (closed) return;
      const token = localStorage.getItem('auth_token') || '';
      const url = `${getApiBase()}/api/user/stream?token=${encodeURIComponent(token)}`;
      const eventSource = new EventSource(url);
      source = eventSource;

      eventSource.onopen = () => {
        retries = 0;
      };

      eventSource.onmessage = (event: MessageEvent) => {
        let message: UserSSEMessage;
        try {
          message = JSON.parse(event.data) as UserSSEMessage;
        } catch (error) {
          optionsRef.current.onError?.(error);
          return;
        }
        switch (message.type) {
          case 'ready':
            optionsRef.current.onReady?.();
            break;
          case 'harness_login_required':
            optionsRef.current.onHarnessLoginRequired?.(
              message.data as HarnessLoginRequestDataFields,
            );
            break;
          case 'harness_login_resolved':
            optionsRef.current.onHarnessLoginResolved?.(
              message.data as HarnessLoginResolvedEvent,
            );
            break;
          case 'heartbeat':
            break;
          default:
            break;
        }
      };

      eventSource.onerror = (event: Event) => {
        optionsRef.current.onError?.(event);
        eventSource.close();
        if (source === eventSource) source = null;
        if (closed) return;
        const delay = Math.min(INITIAL_RETRY_MS * 2 ** retries, MAX_RETRY_MS);
        retries += 1;
        clearTimer();
        timer = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      closed = true;
      clearTimer();
      source?.close();
      source = null;
    };
  }, [enabled]);
}
