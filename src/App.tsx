import { useState, useCallback } from 'react';
import { LogListPanel } from './components/dashboard/LogListPanel';
import { DetailPanel } from './components/viewer/DetailPanel';
import { SettingsContext } from './contexts/SettingsContext';
import { SettingsModal } from './components/settings/SettingsModal';
import { useProxyStatus } from './hooks/useProxyStatus';
import { useLogs } from './hooks/useLogs';
import { useWebSocket } from './hooks/useWebSocket';
import { useEventSource } from './hooks/useEventSource';
import { exportLogs } from './utils/api';
import type { LogEntry, TabType } from './types';
import './App.css';

console.log('[App.tsx] Component loaded');

function App(): JSX.Element {
  console.log('[App] Rendering...');

  // 状态管理
  const [selectedLogId, setSelectedLogId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabType>('request');
  const [settingsOpen, setSettingsOpen] = useState(false);

  // 使用自定义 Hooks
  const { status: proxyStatus, loading: statusLoading, enable, disable } = useProxyStatus();
  const { logs, loading: logsLoading, loadLogs, addLog } = useLogs();

  // WebSocket + SSE 双通道实时推送
  const handleNewLog = useCallback((log: LogEntry) => {
    console.log('[App] New log received:', log.id);
    addLog(log);
  }, [addLog]);

  useWebSocket({
    onLog: handleNewLog,
    onConnect: useCallback(() => console.log('[App] WebSocket connected'), []),
    onDisconnect: useCallback(() => console.log('[App] WebSocket disconnected'), []),
  });

  // SSE 作为备选通道（浏览器原生支持，无需额外依赖）
  useEventSource({
    onLog: handleNewLog,
    onConnect: useCallback(() => console.log('[App] SSE connected'), []),
    onDisconnect: useCallback(() => console.log('[App] SSE disconnected'), []),
  });

  const selectedLog = logs.find(log => log.id === selectedLogId);

  // 切换代理状态
  const handleToggleProxy = async () => {
    try {
      if (proxyStatus.enabled) {
        await disable();
      } else {
        await enable();
      }
    } catch (err) {
      console.error('Failed to toggle proxy:', err);
      alert(err instanceof Error ? err.message : '操作失败');
    }
  };

  const settingsValue: import('./types').SettingsContextValue = {
    preferences: {
      theme: 'light',
      activeTab,
      sidebarWidth: 300,
      autoCollapse: true,
      showThinking: false,
      showFullTools: false,
    },
    updatePreferences: (updates: Partial<typeof settingsValue.preferences>) => {
      if (updates.activeTab) setActiveTab(updates.activeTab);
    },
  };

  // 导出日志处理
  const handleExportLogs = async () => {
    try {
      const result = await exportLogs('jsonl', false);
      if (result.success) {
        alert(`成功导出 ${result.count} 条日志`);
      }
    } catch (err) {
      console.error('Failed to export logs:', err);
      alert('导出失败: ' + (err instanceof Error ? err.message : '未知错误'));
    }
  };

  return (
    <SettingsContext.Provider value={settingsValue}>
      <div className="app-container">
        {/* 控制栏 */}
        <div className="control-bar">
          <div className="control-bar-left">
            <h1 className="app-title">AgentProxy</h1>
            <span className="app-subtitle">AI Agent 代理服务器</span>
          </div>

          <div className="control-bar-center">
            <div className="proxy-status">
              <span className="status-label">代理状态:</span>
              <span className={`status-indicator ${proxyStatus.enabled ? 'enabled' : 'disabled'}`}>
                {proxyStatus.enabled ? '● 已启用' : '○ 未启用'}
              </span>
              {proxyStatus.running && (
                <span className="port-info">
                  (代理端口: {proxyStatus.proxyPort})
                </span>
              )}
            </div>
          </div>

          <div className="control-bar-right">
            <button
              className={`proxy-toggle-button ${proxyStatus.enabled ? 'enabled' : 'disabled'}`}
              onClick={handleToggleProxy}
              disabled={statusLoading}
            >
              {statusLoading ? '...' : proxyStatus.enabled ? '禁用代理' : '启用代理'}
            </button>
            <button
              className="refresh-button"
              onClick={loadLogs}
              disabled={logsLoading}
              title="刷新日志"
            >
              {logsLoading ? '...' : '🔄'}
            </button>
            <button
              className="export-button"
              onClick={handleExportLogs}
              title="导出日志"
            >
              📤
            </button>
            <button
              className="settings-button"
              onClick={() => setSettingsOpen(true)}
              title="代理配置"
            >
              ⚙️
            </button>
          </div>
        </div>

        {/* 主内容区 */}
        <div className="main-split">
          <LogListPanel
            logs={logs}
            selectedId={selectedLogId}
            onSelectLog={setSelectedLogId}
            loading={logsLoading}
          />
          <DetailPanel
            log={selectedLog || null}
            activeTab={activeTab}
            onTabChange={setActiveTab}
          />
        </div>

        {/* 设置弹窗 */}
        <SettingsModal
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
        />
      </div>
    </SettingsContext.Provider>
  );
}

export default App;
