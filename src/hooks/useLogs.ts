/**
 * 日志数据管理 Hook（支持分页加载）
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { getLogs } from '../utils/api';
import type { LogEntry } from '../types';

const PAGE_SIZE = 50;

export function useLogs() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const offsetRef = useRef(0);
  // unmount 防护：异步请求返回晚于卸载时阻断 setState
  const mountedRef = useRef(true);

  // 转换 API 数据格式
  const formatLog = (log: any): LogEntry => ({
    id: log.id,
    timestamp: log.timestamp,
    request: {
      ...log.request,
      body: {
        ...log.request.body,
        messages: (log.request.body.messages || []).map((msg: any) => ({
          role: msg.role,
          content: typeof msg.content === 'string' ? msg.content : (msg.content || []),
        })),
      },
    },
    response: log.response as LogEntry['response'],
    agentType: log.agentType as LogEntry['agentType'],
    apiType: log.apiType as LogEntry['apiType'],
    clientType: log.clientType as LogEntry['clientType'],
    duration: log.duration,
    metadata: log.metadata as LogEntry['metadata'],
    tokenUsage: log.tokenUsage as LogEntry['tokenUsage'],
    kvCache: log.kvCache as LogEntry['kvCache'],
    context: log.context as LogEntry['context'],
    error: log.error,
    isTest: log.isTest,
    providerName: log.providerName,
    endpointType: log.endpointType as LogEntry['endpointType'],
    threadId: log.threadId,
  });

  // 初始加载（最新的 PAGE_SIZE 条）
  const loadLogs = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await getLogs({ limit: PAGE_SIZE, offset: 0 });
      if (!mountedRef.current) return;
      const formatted = (data.logs || []).map(formatLog);
      setLogs(formatted);
      offsetRef.current = formatted.length;
      setHasMore(formatted.length < data.total);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : '加载失败');
      console.error('Failed to load logs:', err);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  };

  // 加载更多（往下翻时调用）
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    try {
      setLoadingMore(true);
      const data = await getLogs({ limit: PAGE_SIZE, offset: offsetRef.current });
      const formatted = (data.logs || []).map(formatLog);
      setLogs(prev => [...prev, ...formatted]);
      offsetRef.current += formatted.length;
      setHasMore(formatted.length >= PAGE_SIZE);
    } catch (err) {
      console.error('Failed to load more logs:', err);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, hasMore]);

  // 添加新日志（SSE 推送等）— 带 ID 去重
  const addLog = (log: LogEntry) => {
    setLogs(prev => {
      if (prev.some(item => item.id === log.id)) return prev;
      return [log, ...prev];
    });
  };

  useEffect(() => {
    mountedRef.current = true;
    loadLogs();
    return () => {
      mountedRef.current = false;
    };
  }, []);

  return {
    logs,
    loading,
    loadingMore,
    hasMore,
    error,
    loadLogs,
    loadMore,
    addLog,
    setLogs,
  };
}
