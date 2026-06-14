import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { LogListPanel } from './components/dashboard/LogListPanel';
import { DetailPanel } from './components/viewer/DetailPanel';
import { SettingsContext } from './contexts/SettingsContext';
import { SettingsModal } from './components/settings/SettingsModal';
import { UsageGuide } from './components/common/UsageGuide';
import { useLogs } from './hooks/useLogs';
import { ArrowPathIcon, Cog6ToothIcon, InformationCircleIcon } from '@heroicons/react/24/outline';
import type { TabType, Provider } from './types';
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
import { getProxyStatus } from './utils/api';

const PROVIDER_FILTER_STORAGE_KEY = 'lucent.providerFilter';
const PROVIDER_FILTER_ALL = 'all';
const ENDPOINT_FILTER_STORAGE_KEY = 'lucent.endpointFilter';
const ENDPOINT_FILTER_ALL = 'all';

function App(): JSX.Element {
  // 读取初始 URL 参数
  const params = new URLSearchParams(window.location.search);
  const [selectedLogId, setSelectedLogId] = useState<string | null>(params.get(URL_PARAM_LOG_ID));
  const [activeTab, setActiveTab] = useState<TabType>(
    (params.get(URL_PARAM_TAB) as TabType) || DEFAULT_ACTIVE_TAB
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [usageGuideOpen, setUsageGuideOpen] = useState(false);
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

  const { logs: allLogs, loading: logsLoading, loadingMore, hasMore, loadLogs, loadMore } = useLogs();

  // 按供应商+协议筛选（客户端）
  const [providerFilter, setProviderFilter] = useState<string>(() => {
    return localStorage.getItem(PROVIDER_FILTER_STORAGE_KEY) || PROVIDER_FILTER_ALL;
  });
  const [endpointFilter, setEndpointFilter] = useState<string>(() => {
    return localStorage.getItem(ENDPOINT_FILTER_STORAGE_KEY) || ENDPOINT_FILTER_ALL;
  });
  const logs = useMemo(() => {
    return allLogs.filter((l) => {
      if (providerFilter !== PROVIDER_FILTER_ALL && l.providerName !== providerFilter) return false;
      if (endpointFilter !== ENDPOINT_FILTER_ALL && l.endpointType !== endpointFilter) return false;
      return true;
    });
  }, [allLogs, providerFilter, endpointFilter]);

  const handleProviderFilterChange = useCallback((name: string) => {
    setProviderFilter(name);
    localStorage.setItem(PROVIDER_FILTER_STORAGE_KEY, name);
  }, []);

  const handleEndpointFilterChange = useCallback((type: string) => {
    setEndpointFilter(type);
    localStorage.setItem(ENDPOINT_FILTER_STORAGE_KEY, type);
  }, []);

  // 从代理状态拉取 providers 列表（用于筛选下拉）
  const [providers, setProviders] = useState<Provider[]>([]);
  useEffect(() => {
    let cancelled = false;
    const loadProviders = async () => {
      try {
        const status = await getProxyStatus();
        const list = (status as { providers?: Provider[] }).providers;
        if (!cancelled && Array.isArray(list)) {
          setProviders(list);
        }
      } catch {
        // 静默失败：筛选下拉为空即不显示
      }
    };
    loadProviders();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedLog = logs.find(log => log.id === selectedLogId);

  const settingsValue: import('./types').SettingsContextValue = {
    preferences: {
      theme: DEFAULT_THEME,
      activeTab,
      sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
      autoCollapse: true,
      showThinking: false,
      showFullTools: false,
      conversationView: 'timeline',
    },
    updatePreferences: (updates: Partial<typeof settingsValue.preferences>) => {
      if (updates.activeTab) {
        setActiveTab(updates.activeTab);
        updateUrl(selectedLogId, updates.activeTab);
      }
    },
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
              Lucent
            </h1>
            <span className="text-[15px] text-text-quaternary">AI Agent 代理</span>
          </div>

          {/* 右：操作 */}
          <div className="ml-auto flex items-center gap-2">
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
              onClick={() => setUsageGuideOpen(true)}
              title="使用说明"
            >
              <InformationCircleIcon className="w-[18px] h-[18px]" />
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
            loadingMore={loadingMore}
            hasMore={hasMore}
            onLoadMore={loadMore}
            width={sidebarWidth}
            providers={providers}
            providerFilter={providerFilter}
            onProviderFilterChange={handleProviderFilterChange}
            endpointFilter={endpointFilter}
            onEndpointFilterChange={handleEndpointFilterChange}
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
        <UsageGuide
          open={usageGuideOpen}
          onClose={() => setUsageGuideOpen(false)}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      </div>
    </SettingsContext.Provider>
  );
}

export default App;
