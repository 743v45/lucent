/**
 * Electron Preload Script
 * 暴露安全的 API 给渲染进程
 */

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('agentProxy', {
  // 代理状态
  getProxyStatus: () => ipcRenderer.invoke('get-proxy-status'),
  toggleProxy: () => ipcRenderer.invoke('toggle-proxy'),

  // 配置
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),

  // 事件监听
  onProxyStatusChanged: (callback) => {
    const listener = (event, status) => callback(status);
    ipcRenderer.on('proxy-status-changed', listener);
    return () => ipcRenderer.removeListener('proxy-status-changed', listener);
  },

  onExportLogs: (callback) => {
    const listener = (event) => callback();
    ipcRenderer.on('export-logs', listener);
    return () => ipcRenderer.removeListener('export-logs', listener);
  },

  onShowProxyStatus: (callback) => {
    const listener = (event) => callback();
    ipcRenderer.on('show-proxy-status', listener);
    return () => ipcRenderer.removeListener('show-proxy-status', listener);
  },

  // 平台信息
  platform: process.platform,
  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  },
});
