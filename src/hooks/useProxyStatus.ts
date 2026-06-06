/**
 * 代理状态管理 Hook
 */
import { useState, useEffect } from 'react';
import { getProxyStatus, enableProxy, disableProxy } from '../utils/api';
import type { ProxyStatus } from '../types';

export function useProxyStatus() {
  const [status, setStatus] = useState<ProxyStatus>({
    enabled: false,
    running: false,
    host: '127.0.0.1',
    webPort: 0,
    proxyPort: 0,
    logFile: null,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 加载状态
  const loadStatus = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await getProxyStatus();
      setStatus(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
      console.error('Failed to load proxy status:', err);
    } finally {
      setLoading(false);
    }
  };

  // 启用代理
  const enable = async () => {
    try {
      setError(null);
      await enableProxy();
      await loadStatus(); // 重新加载状态
    } catch (err) {
      setError(err instanceof Error ? err.message : '启用失败');
      console.error('Failed to enable proxy:', err);
      throw err;
    }
  };

  // 禁用代理
  const disable = async () => {
    try {
      setError(null);
      await disableProxy();
      await loadStatus(); // 重新加载状态
    } catch (err) {
      setError(err instanceof Error ? err.message : '禁用失败');
      console.error('Failed to disable proxy:', err);
      throw err;
    }
  };

  // 初始加载
  useEffect(() => {
    loadStatus();
  }, []);

  return {
    status,
    loading,
    error,
    enable,
    disable,
    refresh: loadStatus,
  };
}
