/**
 * SSE (Server-Sent Events) 连接管理 Hook
 *
 * 作为 WebSocket 的备选/补充方案，使用标准 HTTP SSE 推送日志。
 * 浏览器原生 EventSource 支持，无需额外依赖。
 */
import { useEffect, useRef, useCallback } from 'react';
import type { LogEntry } from '../types';

const SSE_URL = `/api/logs/stream`;

interface EventSourceOptions {
  onLog?: (log: LogEntry) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (error: Event) => void;
}

export function useEventSource({
  onLog,
  onConnect,
  onDisconnect,
  onError,
}: EventSourceOptions = {}) {
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<number>();
  const reconnectAttemptsRef = useRef(0);
  const maxReconnectAttempts = 10;

  // 用 ref 持有最新回调，避免频繁重建 EventSource
  const callbacksRef = useRef({ onLog, onConnect, onDisconnect, onError });
  callbacksRef.current = { onLog, onConnect, onDisconnect, onError };

  const connect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }
    if (esRef.current) {
      esRef.current.close();
    }

    try {
      const es = new EventSource(SSE_URL);
      esRef.current = es;

      es.addEventListener('connected', () => {
        console.log('[SSE] Connected');
        reconnectAttemptsRef.current = 0;
        callbacksRef.current.onConnect?.();
      });

      es.addEventListener('log', (event: MessageEvent) => {
        try {
          const entry = JSON.parse(event.data) as LogEntry;
          callbacksRef.current.onLog?.(entry);
        } catch (err) {
          console.error('[SSE] Failed to parse log event:', err);
        }
      });

      es.onerror = (event: Event) => {
        console.warn('[SSE] Error:', (event as ErrorEvent)?.message || 'unknown');
        callbacksRef.current.onError?.(event);
        es.close();
        esRef.current = null;
        callbacksRef.current.onDisconnect?.();

        // 自动重连
        if (reconnectAttemptsRef.current < maxReconnectAttempts) {
          reconnectAttemptsRef.current++;
          const delay = Math.min(1000 * Math.pow(2, reconnectAttemptsRef.current), 30000);
          console.log(`[SSE] Reconnecting in ${delay}ms (attempt ${reconnectAttemptsRef.current})`);
          reconnectTimeoutRef.current = window.setTimeout(() => connect(), delay);
        }
      };
    } catch (err) {
      console.error('[SSE] Failed to create EventSource:', err);
    }
  }, []);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
  }, []);

  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  return {
    connected: esRef.current?.readyState === EventSource.OPEN,
    connect,
    disconnect,
  };
}
