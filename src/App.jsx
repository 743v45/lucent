import React, { useState, useEffect } from 'react';
import { Layout, message } from 'antd';
import { AppHeader } from './components/common/AppHeader';
import { LogListPanel } from './components/dashboard/LogListPanel';
import { DetailPanel } from './components/viewer/DetailPanel';
import { SettingsContext } from './contexts/SettingsContext';
import './App.css';

const { Content } = Layout;

function App() {
  const [proxyStatus, setProxyStatus] = useState({
    enabled: false,
    running: false,
    port: 7048,
  });

  const [logs, setLogs] = useState([]);
  const [selectedLogId, setSelectedLogId] = useState(null);
  const [activeTab, setActiveTab] = useState('request');
  const [theme, setTheme] = useState('light');
  const [loading, setLoading] = useState(false);

  // 初始化
  useEffect(() => {
    // TODO: 连接代理服务器，获取初始状态
    initProxy();
  }, []);

  const initProxy = async () => {
    try {
      setLoading(true);
      // TODO: 调用代理 API 获取状态
      // const status = await fetchProxyStatus();
      // setProxyStatus(status);
    } catch (error) {
      message.error('连接代理服务器失败');
    } finally {
      setLoading(false);
    }
  };

  const toggleProxy = async () => {
    try {
      // TODO: 调用代理 API 启用/禁用
      setProxyStatus(prev => ({
        ...prev,
        enabled: !prev.enabled,
      }));
      message.success(proxyStatus.enabled ? '代理已禁用' : '代理已启用');
    } catch (error) {
      message.error('操作失败');
    }
  };

  const selectedLog = logs.find(log => log.id === selectedLogId);

  const settingsValue = {
    preferences: {
      theme,
      activeTab,
      sidebarWidth: 300,
    },
    updatePreferences: (updates) => {
      if (updates.theme) setTheme(updates.theme);
      if (updates.activeTab) setActiveTab(updates.activeTab);
    },
  };

  return (
    <SettingsContext.Provider value={settingsValue}>
      <Layout className={`app-container ${theme}`}>
        <AppHeader
          proxyStatus={proxyStatus}
          onToggleProxy={toggleProxy}
          theme={theme}
          onThemeChange={setTheme}
        />
        <Content className="app-content">
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
