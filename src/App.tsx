import React, { useState, useEffect, useCallback } from 'react';
import { Layout, message } from 'antd';
import { LogListPanel } from './components/dashboard/LogListPanel';
import { DetailPanel } from './components/viewer/DetailPanel';
import { SettingsContext } from './contexts/SettingsContext';
import type { LogEntry, ProxyStatus, TabType, Theme } from './types';
import './App.css';

const { Content } = Layout;

function App(): JSX.Element {
  const [proxyStatus, setProxyStatus] = useState<ProxyStatus>({
    enabled: false,
    running: false,
    webPort: 7049,
    proxyPort: 7048,
    logFile: null,
  });

  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [selectedLogId, setSelectedLogId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabType>('request');
  const [theme, setTheme] = useState<Theme>('light');
  const [loading, setLoading] = useState(false);
  const [ws, setWs] = useState<WebSocket | null>(null);

  // 初始化
  useEffect(() => {
    initProxy();
    connectWebSocket();

    return () => {
      if (ws) {
        ws.close();
      }
    };
  }, []);

  // 初始化代理状态
  const initProxy = useCallback(async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/status');
      const status: ProxyStatus = await response.json();
      setProxyStatus(status);

      // 加载日志
      await loadLogs();
    } catch (error) {
      message.error('连接服务器失败');
    } finally {
      setLoading(false);
    }
  }, []);

  // 加载日志
  const loadLogs = useCallback(async () => {
    try {
      const response = await fetch('/api/logs?limit=100');
      const data = await response.json();
      setLogs(data.logs || []);
    } catch (error) {
      console.error('加载日志失败:', error);
    }
  }, []);

  // 连接 WebSocket
  const connectWebSocket = useCallback(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/`;

    const websocket = new WebSocket(wsUrl);

    websocket.onopen = () => {
      console.log('[App] WebSocket 连接成功');
    };

    websocket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'log') {
          setLogs(prev => [...prev, msg.data as LogEntry]);
        }
      } catch (error) {
        console.error('WebSocket 消息解析失败:', error);
      }
    };

    websocket.onerror = (error) => {
      console.error('[App] WebSocket 错误:', error);
    };

    websocket.onclose = () => {
      console.log('[App] WebSocket 连接关闭');
      // 5秒后重连
      setTimeout(() => {
        if (!ws || ws.readyState === WebSocket.CLOSED) {
          connectWebSocket();
        }
      }, 5000);
    };

    setWs(websocket);
  }, [ws]);

  // 切换代理状态
  const toggleProxy = useCallback(async () => {
    try {
      const endpoint = proxyStatus.enabled ? '/api/disable' : '/api/enable';
      const response = await fetch(endpoint, { method: 'POST' });
      const data = await response.json();

      if (data.success) {
        setProxyStatus(prev => ({ ...prev, enabled: !prev.enabled }));
        message.success(!proxyStatus.enabled ? '代理已启用' : '代理已禁用');
      }
    } catch (error) {
      message.error('操作失败');
    }
  }, [proxyStatus.enabled]);

  const selectedLog = logs.find(log => log.id === selectedLogId);

  const settingsValue = {
    preferences: {
      theme,
      activeTab,
      sidebarWidth: 300,
      autoCollapse: true,
      showThinking: false,
      showFullTools: false,
    },
    updatePreferences: (updates) => {
      if (updates.theme) setTheme(updates.theme);
      if (updates.activeTab) setActiveTab(updates.activeTab);
    },
  };

  return (
    <SettingsContext.Provider value={settingsValue}>
      <Layout className={`app-container ${theme}`}>
        <Content className="app-content">
          {/* 顶部控制栏 */}
          <div className="control-bar">
            <div className="control-bar-left">
              <h1 className="app-title">AgentProxy</h1>
              <span className="app-subtitle">AI Agent 代理服务器</span>
            </div>

            <div className="control-bar-center">
              <div className="proxy-status">
                <span className="status-label">代理状态:</span>
                <span className={`status-indicator ${proxyStatus.enabled ? 'enabled' : 'disabled'}`}>
                  {proxyStatus.enabled ? '● 已启用' : '○ 已禁用'}
                </span>
                <button
                  className="toggle-button"
                  onClick={toggleProxy}
                >
                  {proxyStatus.enabled ? '禁用' : '启用'}
                </button>
              </div>
            </div>

            <div className="control-bar-right">
              <button
                className={`theme-button ${theme === 'dark' ? 'dark' : ''}`}
                onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
              >
                {theme === 'light' ? '🌙' : '☀️'}
              </button>
              <button className="refresh-button" onClick={loadLogs}>
                🔄 刷新
              </button>
            </div>
          </div>

          {/* 主内容区 */}
          <div className="main-split">
            <LogListPanel
              logs={logs}
              selectedId={selectedLogId}
              onSelectLog={setSelectedLogId}
              loading={loading}
            />
            <DetailPanel
              log={selectedLog}
              activeTab={activeTab}
              onTabChange={setActiveTab}
            />
          </div>
        </Content>
      </Layout>
    </SettingsContext.Provider>
  );
}

export default App;
