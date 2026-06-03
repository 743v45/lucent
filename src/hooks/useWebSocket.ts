/**
 * WebSocket 连接管理 Hook
 */
import { useEffect, useRef, useCallback } from 'react';
import type { LogEntry } from '../types';

const WS_URL = `ws://${window.location.host}/ws`;

interface WebSocketOptions {
  onMessage?: (data: { type: string; payload: unknown }) => void;
  onLog?: (log: LogEntry) => void;
  onError?: (error: Event) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
}

export function useWebSocket({
  onMessage,
  onLog,
  onError,
  onConnect,
  onDisconnect,
}: WebSocketOptions = {}) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number>();
  const reconnectAttemptsRef = useRef(0);

  // 清理连接
  const cleanup = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  // 连接 WebSocket
  const connect = useCallback(() => {
    // 清理现有连接
    cleanup();

    console.log('[WebSocket] Connecting to', WS_URL);

    try {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('[WebSocket] Connected');
        reconnectAttemptsRef.current = 0;
        onConnect?.();
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          console.log('[WebSocket] Message received:', data.type);

          // 通用消息处理
          onMessage?.(data);

          // 日志消息处理
          if (data.type === 'log' && data.data) {
            onLog?.(data.data as LogEntry);
          }
        } catch (err) {
          console.error('[WebSocket] Failed to parse message:', err);
        }
      };

      ws.onerror = (error) => {
        console.error('[WebSocket] Error:', error);
        onError?.(error);
      };

      ws.onclose = (event) => {
        console.log('[WebSocket] Closed:', event.code, event.reason);
        onDisconnect?.();

        // 自动重连（非正常关闭时）
        if (event.code !== 1000 && reconnectAttemptsRef.current < 10) {
          reconnectAttemptsRef.current++;
          const delay = Math.min(1000 * Math.pow(2, reconnectAttemptsRef.current), 30000);
          console.log(`[WebSocket] Reconnecting in ${delay}ms (attempt ${reconnectAttemptsRef.current})`);

          reconnectTimeoutRef.current = window.setTimeout(() => {
            connect();
          }, delay);
        }
      };
    } catch (err) {
      console.error('[WebSocket] Failed to connect:', err);
      onError?.(err as Event);
    }
  }, [cleanup, onConnect, onDisconnect, onError, onMessage, onLog]);

  // 断开连接
  const disconnect = useCallback(() => {
    cleanup();
    console.log('[WebSocket] Disconnected by user');
  }, [cleanup]);

  // 组件挂载时连接，卸载时断开
  useEffect(() => {
    connect();
    return () => {
      disconnect();
    };
  }, [connect, disconnect]);

  return {
    connected: wsRef.current?.readyState === WebSocket.OPEN,
    connect,
    disconnect,
  };
}
