/**
 * 日志数据管理 Hook（keyset 分页 + 服务端 search/过滤）
 *
 * - 分页：cursor 游标（keyset，深页不退化）。loadLogs 拉首页并重置，loadMore 续页追加。
 * - search / providerName / endpointType 任一变化 → 重新拉首页（服务端过滤，不再客户端筛）。
 * - 请求序号守卫：搜索快速变化时，丢弃过期响应，旧结果不覆盖新结果。
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { getLogs } from '../utils/api';
import type { LogEntry } from '../types';

const PAGE_SIZE = 50;

export interface UseLogsOptions {
  search: string;
  providerName: string;
  endpointType: string;
}

export function useLogs(opts: UseLogsOptions) {
  const { search, providerName, endpointType } = opts;

  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // 下一页 keyset 游标（首页为 null）
  const cursorRef = useRef<string | null>(null);
  // 请求序号：过期响应（晚到的旧请求）不覆盖新结果
  const reqIdRef = useRef(0);
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

  // 首页加载（search/过滤变化或手动刷新时调用，替换列表）
  const loadLogs = useCallback(async () => {
    const reqId = ++reqIdRef.current;
    try {
      setLoading(true);
      setError(null);
      const data = await getLogs({
        limit: PAGE_SIZE,
        search: search.trim() || undefined,
        providerName,
        endpointType,
      });
      if (!mountedRef.current || reqId !== reqIdRef.current) return;
      const formatted = (data.logs || []).map(formatLog);
      setLogs(formatted);
      cursorRef.current = data.nextCursor;
      setHasMore(data.hasMore);
      setTotal(data.total);
    } catch (err) {
      if (!mountedRef.current || reqId !== reqIdRef.current) return;
      setError(err instanceof Error ? err.message : '加载失败');
      console.error('Failed to load logs:', err);
    } finally {
      if (mountedRef.current && reqId === reqIdRef.current) setLoading(false);
    }
  }, [search, providerName, endpointType]);

  // 加载更多（往下翻时调用，追加下一页）
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    // 首页刚加载、还没拿到 nextCursor 时不动；keyset 必须有游标才能续页
    const cursor = cursorRef.current;
    if (!cursor) return;
    const reqId = reqIdRef.current;
    try {
      setLoadingMore(true);
      const data = await getLogs({
        limit: PAGE_SIZE,
        cursor,
        search: search.trim() || undefined,
        providerName,
        endpointType,
      });
      if (!mountedRef.current || reqId !== reqIdRef.current) return;
      const formatted = (data.logs || []).map(formatLog);
      setLogs(prev => [...prev, ...formatted]);
      cursorRef.current = data.nextCursor;
      setHasMore(data.hasMore);
      setTotal(data.total);
    } catch (err) {
      console.error('Failed to load more logs:', err);
    } finally {
      if (mountedRef.current && reqId === reqIdRef.current) setLoadingMore(false);
    }
  }, [loadingMore, hasMore, search, providerName, endpointType]);

  // 添加新日志（SSE 推送等）— 带 ID 去重
  const addLog = (log: LogEntry) => {
    setLogs(prev => {
      if (prev.some(item => item.id === log.id)) return prev;
      return [log, ...prev];
    });
  };

  // search / 过滤变化 → 重新加载首页（loadLogs 是 useCallback，依赖这些值）
  useEffect(() => {
    mountedRef.current = true;
    loadLogs();
    return () => {
      mountedRef.current = false;
    };
  }, [loadLogs]);

  return {
    logs,
    loading,
    loadingMore,
    hasMore,
    total,
    error,
    loadLogs,
    loadMore,
    addLog,
    setLogs,
  };
}
