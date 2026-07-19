/**
 * 日志数据管理 Hook（keyset 分页 + 服务端 search/过滤）
 *
 * - 分页：cursor 游标（keyset，深页不退化）。loadLogs 拉首页并重置，loadMore 续页追加。
 * - search / providerName / endpointType 任一变化 → 重新拉首页（服务端过滤，不再客户端筛）。
 * - 请求序号守卫：搜索快速变化时，丢弃过期响应，旧结果不覆盖新结果。
 */
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { getLogs } from '../utils/api';
import { makeSemaphore } from '../utils/concurrency';
import { API_BASE_PATH } from '../constants';
import type { LogEntry } from '../types';

const PAGE_SIZE = 50;
/** logs state 软上限：loadMore/addLog 追加后裁剪到最前（最新）N 条，防浏览器无限堆积 */
const LOGS_SOFT_CAP = 500;

/** 转换 API 数据格式（模块级纯函数，供 loadLogs/loadThread/SSE 共享） */
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
  ttftFirstTokenMs: log.ttftFirstTokenMs,
  ttftThinkingMs: log.ttftThinkingMs,
  ttftAnswerMs: log.ttftAnswerMs,
  tokensPerSecond: log.tokensPerSecond,
  metadata: log.metadata as LogEntry['metadata'],
  tokenUsage: log.tokenUsage as LogEntry['tokenUsage'],
  kvCache: log.kvCache as LogEntry['kvCache'],
  context: log.context as LogEntry['context'],
  error: log.error,
  isTest: log.isTest,
  providerName: log.providerName,
  endpointType: log.endpointType as LogEntry['endpointType'],
  threadId: log.threadId,
  expiresAt: log.expiresAt,
});

export interface UseLogsOptions {
  search: string;
  providerName: string;
  endpointType: string;
}

export function useLogs(opts: UseLogsOptions) {
  const { search, providerName, endpointType } = opts;

  const [logs, setLogs] = useState<LogEntry[]>([]);
  // 60s tick：让「已过期临时日志」过滤每分钟重新评估，避免过期项变幽灵残留
  const [nowTick, setNowTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setNowTick(n => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);
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
  // loadMore 重入锁：读 ref 即时值，避免闭包里的 loadingMore 陈旧导致 TOCTOU 并发
  const loadingMoreRef = useRef(false);

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
    // 守卫走 ref：闭包里的 loadingMore 是陈旧值，连续两次调用（第二次在第一次
    // setLoadingMore 提交前）都会放行 → 同一 cursor 发两次请求 + append 不去重 → 整页复制。
    // 改读 loadingMoreRef 即时收口；reqId 自增做请求隔离（与 loadLogs 一致）。
    if (loadingMoreRef.current || !hasMore) return;
    // 首页刚加载、还没拿到 nextCursor 时不动；keyset 必须有游标才能续页
    const cursor = cursorRef.current;
    if (!cursor) return;
    const reqId = ++reqIdRef.current;
    loadingMoreRef.current = true;
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
      setLogs(prev => {
        // 按 id 去重：并发/重试场景下 prev 可能已含 formatted 的 id（对比 addLog 的 .some(id) 去重）
        const existing = new Set(prev.map(l => l.id));
        const combined = [...prev, ...formatted.filter(l => !existing.has(l.id))];
        // 软上限收口：累计超 cap 时裁到 cap，且分页同步收口（按钮如实消失）；
        // 否则服务端 hasMore=true 会让按钮常驻、点击无效、翻不到更老的日志。
        if (combined.length > LOGS_SOFT_CAP) {
          setHasMore(false);
          return combined.slice(0, LOGS_SOFT_CAP);
        }
        setHasMore(data.hasMore);
        return combined;
      });
      cursorRef.current = data.nextCursor;
      setTotal(data.total);
    } catch (err) {
      console.error('Failed to load more logs:', err);
    } finally {
      if (mountedRef.current && reqId === reqIdRef.current) setLoadingMore(false);
      loadingMoreRef.current = false;
    }
  }, [hasMore, search, providerName, endpointType]);

  // 添加新日志（SSE 推送等）— 带 ID 去重 + 软上限裁剪。useCallback 稳定引用供 SSE useEffect 依赖。
  const addLog = useCallback((log: LogEntry) => {
    setLogs(prev => {
      if (prev.some(item => item.id === log.id)) return prev;
      const combined = [log, ...prev];
      return combined.length > LOGS_SOFT_CAP ? combined.slice(0, LOGS_SOFT_CAP) : combined;
    });
  }, []);

  // SSE 实时推送：新日志自动进列表。filter 变化经 ref 同步，不重建连接。
  // 过滤一致性：不合当前 provider/endpoint 的丢弃；搜索态不自动加（避免污染 FTS 检索结果，靠刷新重搜）。
  const filterRef = useRef({ providerName, endpointType, search });
  filterRef.current = { providerName, endpointType, search };
  useEffect(() => {
    const es = new EventSource(`${API_BASE_PATH}/logs/stream`);
    es.addEventListener('log', (e) => {
      try {
        const log = formatLog(JSON.parse((e as MessageEvent).data));
        const { providerName: p, endpointType: et, search: s } = filterRef.current;
        if (p !== 'all' && log.providerName !== p) return;
        if (et !== 'all' && log.endpointType !== et) return;
        if (s.trim()) return;
        addLog(log);
      } catch (err) {
        console.error('SSE log 解析失败:', err);
      }
    });
    return () => es.close();
  }, [addLog]);

  // search / 过滤变化 → 重新加载首页（loadLogs 是 useCallback，依赖这些值）
  useEffect(() => {
    mountedRef.current = true;
    loadLogs();
    return () => {
      mountedRef.current = false;
    };
  }, [loadLogs]);

  // 过滤已过期临时日志（expiresAt < now），每分钟随 nowTick 重新评估；
  // 配合软上限 + 服务端清理，保证前端不堆积过期幽灵条目。
  const visibleLogs = useMemo(
    () => logs.filter(l => !l.expiresAt || Date.parse(l.expiresAt) > Date.now()),
    [logs, nowTick],
  );

  // 会话视图首屏多组同时按 threadId 全量加载时，限制并发拉取数，其余排队，避免瞬时 N 个全量分页请求。
  const loadSem = useMemo(() => makeSemaphore(3), []);
  // 按 threadId 后端全量拉一个会话（会话视图组内全量加载用）；透传当前 search/provider/endpoint
  // 筛选，使组内全量与列表筛选口径一致。分页续拉直到 hasMore=false；走与 visibleLogs 一致的 expiresAt 过滤。
  const loadThread = useCallback(async (threadId: string): Promise<LogEntry[]> => {
    return loadSem(async () => {
      const all: LogEntry[] = [];
      let cursor: string | undefined;
      do {
        const data = await getLogs({
          threadId,
          limit: 500,
          cursor,
          search: search.trim() || undefined,
          providerName,
          endpointType,
        });
        all.push(...(data.logs || []).map(formatLog));
        cursor = data.nextCursor ?? undefined;
        if (!data.hasMore) break;
      } while (cursor);
      return all.filter(l => !l.expiresAt || Date.parse(l.expiresAt) > Date.now());
    });
  }, [search, providerName, endpointType, loadSem]);

  return {
    logs: visibleLogs,
    loading,
    loadingMore,
    hasMore,
    total,
    error,
    loadLogs,
    loadMore,
    addLog,
    setLogs,
    loadThread,
  };
}
