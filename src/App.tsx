import { useState, useCallback, useRef, useEffect } from 'react';
import { LogListPanel } from './components/dashboard/LogListPanel';
import { DetailPanel } from './components/viewer/DetailPanel';
import { SettingsContext } from './contexts/SettingsContext';
import { SettingsModal } from './components/settings/SettingsModal';
import { useProxyStatus } from './hooks/useProxyStatus';
import { useLogs } from './hooks/useLogs';
import { useEventSource } from './hooks/useEventSource';
import { exportLogs } from './utils/api';
import { ArrowPathIcon, ArrowUpTrayIcon, Cog6ToothIcon } from '@heroicons/react/24/outline';
import type { LogEntry, TabType } from './types';
import {
  URL_PARAM_LOG_ID,
  URL_PARAM_TAB,
  STORAGE_KEY_SIDEBAR_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  DEFAULT_THEME,
  DEFAULT_ACTIVE_TAB,
} from './constants';

function App(): JSX.Element {
  // 读取初始 URL 参数
  const params = new URLSearchParams(window.location.search);
  const [selectedLogId, setSelectedLogId] = useState<string | null>(params.get(URL_PARAM_LOG_ID));
  const [activeTab, setActiveTab] = useState<TabType>(
    (params.get(URL_PARAM_TAB) as TabType) || DEFAULT_ACTIVE_TAB
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEY_SIDEBAR_WIDTH);
    return saved ? parseInt(saved, 10) : SIDEBAR_DEFAULT_WIDTH;
  });
  const isDragging = useRef(false);

  // 同步状态到 URL
  const updateUrl = useCallback((logId: string | null, tab: TabType) => {
    const p = new URLSearchParams();
    if (logId) p.set(URL_PARAM_LOG_ID, logId);
    if (tab !== DEFAULT_ACTIVE_TAB) p.set(URL_PARAM_TAB, tab);
    const qs = p.toString();
    history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname);
  }, []);

  // 包装回调：同时更新状态和 URL
  const handleSelectLog = useCallback((id: string) => {
    setSelectedLogId(id);
    updateUrl(id, activeTab);
  }, [activeTab, updateUrl]);

  const handleTabChange = useCallback((tab: TabType) => {
    setActiveTab(tab);
    updateUrl(selectedLogId, tab);
  }, [selectedLogId, updateUrl]);

  const { status: proxyStatus, refresh: refreshStatus } = useProxyStatus();
  const { logs, loading: logsLoading, loadLogs, addLog } = useLogs();

  const handleNewLog = useCallback((log: LogEntry) => {
    addLog(log);
  }, [addLog]);

  useEventSource({
    onLog: handleNewLog,
    onConnect: useCallback(() => console.log('[App] SSE connected'), []),
    onDisconnect: useCallback(() => console.log('[App] SSE disconnected'), []),
  });

  const selectedLog = logs.find(log => log.id === selectedLogId);

  const settingsValue: import('./types').SettingsContextValue = {
    preferences: {
      theme: DEFAULT_THEME,
      activeTab,
      sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
      autoCollapse: true,
      showThinking: false,
      showFullTools: false,
    },
    updatePreferences: (updates: Partial<typeof settingsValue.preferences>) => {
      if (updates.activeTab) {
        setActiveTab(updates.activeTab);
        updateUrl(selectedLogId, updates.activeTab);
      }
    },
  };

  const handleExportLogs = async () => {
    try {
      const result = await exportLogs('jsonl', false);
      if (result.success) {
        alert(`成功导出 ${result.count} 条日志`);
      }
    } catch (err) {
      console.error('Failed to export logs:', err);
    }
  };

  // 拖拽分割栏处理
  const handleMouseDown = useCallback(() => {
    isDragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging.current) return;
    const newWidth = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, e.clientX));
    setSidebarWidth(newWidth);
  }, []);

  const handleMouseUp = useCallback(() => {
    isDragging.current = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    // 保存宽度到 localStorage
    localStorage.setItem(STORAGE_KEY_SIDEBAR_WIDTH, String(sidebarWidth));
  }, [sidebarWidth]);

  // 绑定全局鼠标事件
  useEffect(() => {
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [handleMouseMove, handleMouseUp]);

  return (
    <SettingsContext.Provider value={settingsValue}>
      <div className="flex flex-col w-screen h-screen bg-bg-deep text-text-primary">
        {/* 顶栏 */}
        <div className="flex items-center h-[51px] px-5 bg-bg-panel border-b border-border-subtle shrink-0">
          {/* 左：标题 */}
          <div className="flex items-center gap-3">
            <h1 className="text-[19px] font-[510] tracking-[-0.24px] text-text-primary">
              AgentProxy
            </h1>
            <span className="text-[15px] text-text-quaternary">AI Agent 代理</span>
          </div>

          {/* 中：状态 */}
          <div className="flex-1 flex items-center justify-center gap-3">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-bg-hover border border-border-subtle">
              <span className="text-[15px] text-success font-[510]">● 运行中</span>
              <span className="text-[14px] text-text-quaternary">:{proxyStatus.proxyPort}</span>
            </div>
          </div>

          {/* 右：操作 */}
          <div className="flex items-center gap-2">
            <button
              className="px-2 py-1.5 rounded-md text-lg text-text-tertiary hover:text-text-primary hover:bg-bg-active transition-colors"
              onClick={loadLogs}
              disabled={logsLoading}
              title="刷新"
            >
              <ArrowPathIcon className="w-[18px] h-[18px]" />
            </button>
            <button
              className="px-2 py-1.5 rounded-md text-lg text-text-tertiary hover:text-text-primary hover:bg-bg-active transition-colors"
              onClick={handleExportLogs}
              title="导出"
            >
              <ArrowUpTrayIcon className="w-[18px] h-[18px]" />
            </button>
            <button
              className="px-2 py-1.5 rounded-md text-lg text-text-tertiary hover:text-text-primary hover:bg-bg-active transition-colors"
              onClick={() => setSettingsOpen(true)}
              title="配置"
            >
              <Cog6ToothIcon className="w-[18px] h-[18px]" />
            </button>
          </div>
        </div>

        {/* 主区域 */}
        <div className="flex flex-1 overflow-hidden">
          <LogListPanel
            logs={logs}
            selectedId={selectedLogId}
            onSelectLog={handleSelectLog}
            loading={logsLoading}
            width={sidebarWidth}
          />
          {/* 拖拽分割栏 */}
          <div
            className="w-1 bg-border-subtle hover:bg-brand-accent cursor-col-resize transition-colors shrink-0"
            onMouseDown={handleMouseDown}
          />
          <DetailPanel
            log={selectedLog || null}
            activeTab={activeTab}
            onTabChange={handleTabChange}
          />
        </div>

        <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      </div>
    </SettingsContext.Provider>
  );
}

export default App;
