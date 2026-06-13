/**
 * 代理状态管理 Hook
 */
import { useState, useEffect, useRef } from 'react';
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
  // unmount 防护：异步请求返回晚于卸载时阻断 setState
  const mountedRef = useRef(true);

  // 加载状态
  const loadStatus = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await getProxyStatus();
      if (!mountedRef.current) return;
      setStatus(data);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : '加载失败');
      console.error('Failed to load proxy status:', err);
    } finally {
      if (mountedRef.current) setLoading(false);
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
    mountedRef.current = true;
    loadStatus();
    return () => {
      mountedRef.current = false;
    };
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
