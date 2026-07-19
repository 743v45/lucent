import { useState, useCallback, useRef, useEffect } from 'react';
import { message, Radio, InputNumber, Popover } from 'antd';
import { LogListPanel } from './components/dashboard/LogListPanel';
import { DetailPanel } from './components/viewer/DetailPanel';
import { SettingsContext } from './contexts/SettingsContext';
import { SettingsModal } from './components/settings/SettingsModal';
import { BodyRewriteModal } from './components/settings/BodyRewriteModal';
import { UsageGuide } from './components/common/UsageGuide';
import { useLogs } from './hooks/useLogs';
import { ArchiveBoxIcon, ArrowPathIcon, ChevronDownIcon, ClockIcon, Cog6ToothIcon, EyeSlashIcon, InformationCircleIcon, WrenchScrewdriverIcon } from '@heroicons/react/24/outline';
import type { TabType, Provider, LogMode } from './types';
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
import { getProxyStatus, setLogMode, setRetentionDays as setRetentionDaysApi } from './utils/api';

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
  const [conversationView, setConversationView] = useState<'timeline' | 'session'>('timeline');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [rewriteOpen, setRewriteOpen] = useState(false);
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

  // 按供应商+协议筛选（服务端）
  const [providerFilter, setProviderFilter] = useState<string>(() => {
    return localStorage.getItem(PROVIDER_FILTER_STORAGE_KEY) || PROVIDER_FILTER_ALL;
  });
  const [endpointFilter, setEndpointFilter] = useState<string>(() => {
    return localStorage.getItem(ENDPOINT_FILTER_STORAGE_KEY) || ENDPOINT_FILTER_ALL;
  });

  // 搜索：输入即时更新本地态 searchInput，防抖 300ms 后才写入 searchTerm 触发请求
  const [searchInput, setSearchInput] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setSearchTerm(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const { logs, loading: logsLoading, loadingMore, hasMore, total, loadLogs, loadMore, loadThread } = useLogs({
    search: searchTerm,
    providerName: providerFilter,
    endpointType: endpointFilter,
  });

  const handleProviderFilterChange = useCallback((name: string) => {
    setProviderFilter(name);
    localStorage.setItem(PROVIDER_FILTER_STORAGE_KEY, name);
  }, []);

  const handleEndpointFilterChange = useCallback((type: string) => {
    setEndpointFilter(type);
    localStorage.setItem(ENDPOINT_FILTER_STORAGE_KEY, type);
  }, []);

  // 从代理状态拉取 providers 列表（用于筛选下拉）+ 记录开关状态
  const [providers, setProviders] = useState<Provider[]>([]);
  // 日志记录模式（默认 archive=存档；off=过路不记；temporary=临时带 TTL 自动清理）
  const [logMode, setLogModeState] = useState<LogMode>('archive');
  const [logModeEnvLocked, setLogModeEnvLocked] = useState<boolean>(false);
  const [tempTtlMinutes, setTempTtlMinutes] = useState<number>(30);
  const [retentionDays, setRetentionDaysState] = useState<number>(3);
  const [logModeBusy, setLogModeBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const loadProviders = async () => {
      try {
        const status = await getProxyStatus();
        if (!cancelled) {
          const list = (status as { providers?: Provider[] }).providers;
          if (Array.isArray(list)) {
            setProviders(list);
          }
          setLogModeState(status.logMode ?? 'archive');
          setLogModeEnvLocked(status.logModeEnvLocked ?? false);
          setTempTtlMinutes(status.tempLogTtlMinutes ?? 30);
          setRetentionDaysState(status.retentionDays ?? 3);
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

  // 切换日志记录模式（无二次确认；env 锁定时不可切并提示）
  const handleLogModeChange = useCallback(async (mode: LogMode) => {
    if (logModeEnvLocked) {
      message.warning('记录模式被环境变量锁定，无法在此切换');
      return;
    }
    setLogModeBusy(true);
    try {
      const r = await setLogMode(mode);
      setLogModeState(r.logMode);
      setLogModeEnvLocked(r.envLocked);
      if (r.envLocked) {
        message.warning('记录模式被环境变量锁定，未生效');
      } else if (mode === 'off') {
        message.success('已切到过路：转发照旧，不再记录日志');
      } else if (mode === 'temporary') {
        message.success(`已切到临时模式：记录 ${tempTtlMinutes} 分钟后自动清理`);
      } else {
        message.success('已切到存档模式：按保留期清理');
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : '切换失败');
    } finally {
      setLogModeBusy(false);
    }
  }, [logModeEnvLocked, tempTtlMinutes]);

  // 改时长（TTL/保留期）仅本地，关闭 Popover 时统一提交
  const handleTempTtlChange = useCallback((val: number | null) => {
    if (val == null || val < 1) return;
    setTempTtlMinutes(val);
  }, []);
  const handleRetentionChange = useCallback((val: number | null) => {
    if (val == null || val < 1) return;
    setRetentionDaysState(val);
  }, []);

  // 打开时记初始值；关闭时比较——变了才提交并弹提醒（避免无改动也提交/弹 toast）
  const openedTtlRef = useRef<number | null>(null);
  const openedRetentionRef = useRef<number | null>(null);
  const handlePopoverOpenChange = useCallback((open: boolean) => {
    if (open) {
      openedTtlRef.current = tempTtlMinutes;
      openedRetentionRef.current = retentionDays;
      return;
    }
    const ttlChanged = openedTtlRef.current !== tempTtlMinutes;
    const retentionChanged = openedRetentionRef.current !== retentionDays;
    if (!ttlChanged && !retentionChanged) return;
    setLogModeBusy(true);
    Promise.all([
      ttlChanged ? setLogMode(logMode, tempTtlMinutes) : Promise.resolve(),
      retentionChanged ? setRetentionDaysApi(retentionDays) : Promise.resolve(),
    ]).then(() => {
      setLogModeBusy(false);
      if (ttlChanged) message.success(tempTtlMinutes === 0 ? '存活时长：立即过期（0 分）' : `存活时长已保存为 ${tempTtlMinutes} 分`);
      if (retentionChanged) message.success(`保留期已保存为 ${retentionDays} 天`);
    }).catch((e) => {
      setLogModeBusy(false);
      message.error(e instanceof Error ? e.message : '保存时长失败');
    });
  }, [logMode, tempTtlMinutes, retentionDays]);

  const selectedLog = logs.find(log => log.id === selectedLogId);

  const settingsValue: import('./types').SettingsContextValue = {
    preferences: {
      theme: DEFAULT_THEME,
      activeTab,
      sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
      autoCollapse: true,
      showThinking: false,
      showFullTools: false,
      conversationView,
    },
    updatePreferences: (updates: Partial<typeof settingsValue.preferences>) => {
      if (updates.activeTab) {
        setActiveTab(updates.activeTab);
        updateUrl(selectedLogId, updates.activeTab);
      }
      if (updates.conversationView) {
        setConversationView(updates.conversationView);
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
              data-testid="refresh-btn"
              className="px-2 py-1.5 rounded-md text-lg text-text-tertiary hover:text-text-primary hover:bg-bg-active transition-colors"
              onClick={loadLogs}
              disabled={logsLoading}
              title="刷新"
            >
              <ArrowPathIcon className="w-[18px] h-[18px]" />
            </button>
            {/* 日志记录模式：[📂 当前态 ▾] 一个 Popover——Radio 三态选模式 + 两时长常驻可改 + 清临时。
                选模式归选模式、配置归配置，但同处一面；配置常驻，无需选中即可改。 */}
            <Popover
              trigger="click"
              placement="bottomRight"
              onOpenChange={handlePopoverOpenChange}
              content={
                <div className="w-[300px] flex flex-col gap-1 py-1">
                  <div className="flex flex-col gap-1 py-1">
                    <label data-testid="mode-off" className={`flex items-center gap-2 px-2 py-1 rounded-md cursor-pointer ${logMode === 'off' ? 'bg-bg-active' : 'hover:bg-bg-active'}`}>
                      <Radio checked={logMode === 'off'} disabled={logModeEnvLocked || logModeBusy} onChange={() => handleLogModeChange('off')} />
                      <span className="text-[13px] text-text-primary">过路</span>
                      <span className="ml-auto text-[11px] text-text-quaternary">不记录日志</span>
                    </label>
                    <label data-testid="mode-temporary" className={`flex items-center gap-2 px-2 py-1 rounded-md cursor-pointer ${logMode === 'temporary' ? 'bg-bg-active' : 'hover:bg-bg-active'}`}>
                      <Radio checked={logMode === 'temporary'} disabled={logModeEnvLocked || logModeBusy} onChange={() => handleLogModeChange('temporary')} />
                      <span className="text-[13px] text-text-primary">临时</span>
                      <span className="ml-auto flex items-center gap-1.5">
                        <span className="w-16 text-right text-[12px] text-text-secondary">存活时长</span>
                        <InputNumber data-testid="temp-ttl-input" size="small" min={0} max={1440} value={tempTtlMinutes} onChange={(v) => handleTempTtlChange(v as number | null)} addonAfter="分" className="w-[78px]" />
                      </span>
                    </label>
                    <label data-testid="mode-archive" className={`flex items-center gap-2 px-2 py-1 rounded-md cursor-pointer ${logMode === 'archive' ? 'bg-bg-active' : 'hover:bg-bg-active'}`}>
                      <Radio checked={logMode === 'archive'} disabled={logModeEnvLocked || logModeBusy} onChange={() => handleLogModeChange('archive')} />
                      <span className="text-[13px] text-text-primary">存档</span>
                      <span className="ml-auto flex items-center gap-1.5">
                        <span className="w-16 text-right text-[12px] text-text-secondary">保留期</span>
                        <InputNumber data-testid="retention-input" size="small" min={1} max={3650} value={retentionDays} onChange={(v) => handleRetentionChange(v as number | null)} addonAfter="天" className="w-[78px]" />
                      </span>
                    </label>
                    {logModeEnvLocked && (
                      <div className="text-[12px] text-amber-600 flex items-center gap-1 px-2 pt-1">
                        <InformationCircleIcon className="w-3.5 h-3.5" />
                        被环境变量锁定，切换不生效
                      </div>
                    )}
                  </div>
                  {logModeEnvLocked && (
                    <div className="text-[12px] text-amber-600 flex items-center gap-1">
                      <InformationCircleIcon className="w-3.5 h-3.5" />
                      被环境变量锁定，切换不生效
                    </div>
                  )}
                </div>
              }
            >
              <button data-testid="log-mode-btn" disabled={logModeEnvLocked || logModeBusy} className="flex items-center gap-1.5 px-2 py-1.5 rounded-md text-[13px] text-text-secondary hover:text-text-primary hover:bg-bg-active transition-colors disabled:opacity-40" title="日志记录模式">
                {logMode === 'off' ? <EyeSlashIcon className="w-[18px] h-[18px]" /> : logMode === 'temporary' ? <ClockIcon className="w-[18px] h-[18px]" /> : <ArchiveBoxIcon className="w-[18px] h-[18px]" />}
                {logMode === 'off' ? '过路' : logMode === 'temporary' ? '临时' : '存档'}
                <ChevronDownIcon className="w-3.5 h-3.5 text-text-quaternary" />
              </button>
            </Popover>
            <button
              className="px-2 py-1.5 rounded-md text-lg text-text-tertiary hover:text-text-primary hover:bg-bg-active transition-colors"
              onClick={() => setUsageGuideOpen(true)}
              title="使用说明"
              data-testid="usage-guide-trigger"
            >
              <InformationCircleIcon className="w-[18px] h-[18px]" />
            </button>
            <button
              className="px-2 py-1.5 rounded-md text-lg text-text-tertiary hover:text-text-primary hover:bg-bg-active transition-colors"
              onClick={() => setRewriteOpen(true)}
              title="Body 重写规则"
            >
              <WrenchScrewdriverIcon className="w-[18px] h-[18px]" />
            </button>
            <button
              data-testid="settings-open-btn"
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
            total={total}
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
            searchTerm={searchInput}
            onSearchChange={setSearchInput}
            conversationView={conversationView}
            onConversationViewChange={(v) => setConversationView(v)}
            loadThread={loadThread}
          />
          {/* 拖拽分割栏 */}
          <div
            data-testid="sidebar-splitter"
            className="w-1 bg-border-subtle hover:bg-brand-accent cursor-col-resize transition-colors shrink-0"
            onMouseDown={handleMouseDown}
          />
          <DetailPanel
            log={selectedLog || null}
            activeTab={activeTab}
            onTabChange={handleTabChange}
            searchTerm={searchTerm}
          />
        </div>

        <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
        <BodyRewriteModal open={rewriteOpen} onClose={() => setRewriteOpen(false)} />
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
