import { useEffect, useRef, useState } from 'react';

interface SSEMessage {
  type: string;
  data?: unknown;
}

interface UseSessionStreamOptions {
  sessionId: string;
  onMessage?: (message: unknown) => void;
  onHistory?: (messages: unknown[]) => void;
  onStatus?: (status: string) => void;
  onError?: (error: Event) => void;
}

const MAX_CONSECUTIVE_ERRORS = 3;

export function useSessionStream({
  sessionId,
  onMessage,
  onHistory,
  onStatus,
  onError,
}: UseSessionStreamOptions) {
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<Event | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const errorCountRef = useRef(0);

  useEffect(() => {
    if (!sessionId) return;

    errorCountRef.current = 0;

    const apiBase = import.meta.env.VITE_API_URL || 'http://localhost:4000';
    const token = localStorage.getItem('auth_token') || '';
    const eventSource = new EventSource(`${apiBase}/api/session/${sessionId}/stream?token=${encodeURIComponent(token)}`);
    eventSourceRef.current = eventSource;

    eventSource.onopen = () => {
      setIsConnected(true);
      setError(null);
      errorCountRef.current = 0;
    };

    eventSource.onmessage = (event) => {
      try {
        const data: SSEMessage = JSON.parse(event.data);
        
        switch (data.type) {
          case 'history':
            onHistory?.(data.data as unknown[]);
            break;
          case 'message':
            onMessage?.(data.data);
            break;
          case 'status':
            onStatus?.((data.data as { status: string }).status);
            break;
          case 'heartbeat':
            // Keep-alive, no action needed
            break;
          default:
            console.warn('Unknown SSE message type:', data.type);
        }
      } catch (err) {
        console.error('Failed to parse SSE message:', err);
      }
    };

    eventSource.onerror = (event) => {
      setIsConnected(false);
      errorCountRef.current += 1;

      if (errorCountRef.current >= MAX_CONSECUTIVE_ERRORS && !localStorage.getItem('auth_token')) {
        eventSource.close();
        window.location.href = '/login';
        return;
      }

      setError(event);
      onError?.(event);
    };

    return () => {
      eventSource.close();
      eventSourceRef.current = null;
      setIsConnected(false);
    };
  }, [sessionId, onMessage, onHistory, onStatus, onError]);

  const disconnect = () => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    setIsConnected(false);
  };

  return {
    isConnected,
    error,
    disconnect,
  };
}