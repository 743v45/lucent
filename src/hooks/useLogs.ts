/**
 * 日志数据管理 Hook
 */
import { useState, useEffect } from 'react';
import { getLogs } from '../utils/api';
import type { LogEntry } from '../types';

export function useLogs() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 加载日志
  const loadLogs = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await getLogs();
      // 转换 API 返回的数据格式为 LogEntry 格式
      const formattedLogs = (data.logs || []).map((log): LogEntry => ({
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
        subAgentType: log.subAgentType as LogEntry['subAgentType'],
        duration: log.duration,
        metadata: log.metadata as LogEntry['metadata'],
        error: log.error,
      }));
      setLogs(formattedLogs);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
      console.error('Failed to load logs:', err);
    } finally {
      setLoading(false);
    }
  };

  // 添加新日志（用于 WebSocket 推送）— 带 ID 去重，防止双通道重复
  const addLog = (log: LogEntry) => {
    setLogs(prev => {
      // 如果已存在相同 ID，跳过
      if (prev.some(item => item.id === log.id)) {
        return prev;
      }
      return [log, ...prev];
    });
  };

  // 初始加载
  useEffect(() => {
    loadLogs();
  }, []);

  return {
    logs,
    loading,
    error,
    loadLogs,
    addLog,
    setLogs,
  };
}
