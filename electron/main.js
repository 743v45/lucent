/**
 * AgentProxy Electron 主进程
 *
 * 功能：
 * 1. 创建应用窗口
 * 2. 管理菜单栏
 * 3. 管理系统托盘
 * 4. 启动/管理代理服务器
 */

import { app, BrowserWindow, Menu, Tray, ipcMain, dialog, nativeImage } from 'electron';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, '..');

// 配置目录
const CONFIG_DIR = join(homedir(), '.agentproxy');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

// 状态
let mainWindow = null;
let tray = null;
let proxyServer = null;
let proxyPort = 7048;
let proxyEnabled = false;

/**
 * 初始化配置目录
 */
function initConfigDir() {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  if (!existsSync(CONFIG_FILE)) {
    writeFileSync(CONFIG_FILE, JSON.stringify({
      proxy: {
        enabled: false,
        port: proxyPort,
      },
      ui: {
        theme: 'light',
      },
    }, null, 2));
  }
}

/**
 * 读取配置
 */
function readConfig() {
  try {
    const data = readFileSync(CONFIG_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    console.error('[Electron] 读取配置失败:', error);
    return { proxy: { enabled: false, port: proxyPort }, ui: { theme: 'light' } };
  }
}

/**
 * 保存配置
 */
function saveConfig(config) {
  try {
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (error) {
    console.error('[Electron] 保存配置失败:', error);
  }
}

/**
 * 创建菜单栏
 */
function createMenuBar() {
  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '导出日志',
          accelerator: 'CmdOrCtrl+E',
          click: () => {
            mainWindow?.webContents.send('export-logs');
          },
        },
        { type: 'separator' },
        {
          label: '退出',
          accelerator: 'CmdOrCtrl+Q',
          click: () => {
            app.quit();
          },
        },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: '代理',
      submenu: [
        {
          label: '启用代理',
          type: 'checkbox',
          checked: proxyEnabled,
          accelerator: 'CmdOrCtrl+Shift+P',
          click: () => {
            toggleProxy();
          },
        },
        { type: 'separator' },
        {
          label: '代理状态',
          click: () => {
            mainWindow?.webContents.send('show-proxy-status');
          },
        },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              title: 'AgentProxy',
              message: 'AgentProxy',
              detail: 'AI Agent 代理服务器\n版本 0.1.0',
              buttons: ['确定'],
            });
          },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

/**
 * 创建系统托盘
 */
function createTray() {
  // TODO: 创建托盘图标
  // tray = new Tray(nativeImage.createFromPath(...));
  // const contextMenu = Menu.buildFromTemplate([...]);
  // tray.setContextMenu(contextMenu);
}

/**
 * 切换代理状态
 */
async function toggleProxy() {
  try {
    if (proxyEnabled) {
      // 禁用代理
      if (proxyServer) {
        const { stopProxy } = await import('../server/index.js');
        await stopProxy();
        proxyServer = null;
      }
      proxyEnabled = false;
    } else {
      // 启用代理
      const { startProxy } = await import('../server/index.js');
      proxyServer = await startProxy(proxyPort);
      proxyEnabled = true;
    }

    // 更新配置
    const config = readConfig();
    config.proxy.enabled = proxyEnabled;
    saveConfig(config);

    // 更新菜单
    createMenuBar();

    // 通知窗口
    mainWindow?.webContents.send('proxy-status-changed', {
      enabled: proxyEnabled,
      port: proxyPort,
    });
  } catch (error) {
    console.error('[Electron] 切换代理失败:', error);
    dialog.showErrorBox('错误', `切换代理失败: ${error.message}`);
  }
}

/**
 * 创建主窗口
 */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    show: false,
  });

  // 开发模式加载 Vite 服务器
  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(join(__dirname, '../dist/index.html'));
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * 注册 IPC 处理器
 */
function registerIpcHandlers() {
  // 获取代理状态
  ipcMain.handle('get-proxy-status', () => {
    return {
      enabled: proxyEnabled,
      running: !!proxyServer,
      port: proxyPort,
    };
  });

  // 切换代理
  ipcMain.handle('toggle-proxy', async () => {
    await toggleProxy();
    return { enabled: proxyEnabled };
  });

  // 获取配置
  ipcMain.handle('get-config', () => {
    return readConfig();
  });

  // 保存配置
  ipcMain.handle('save-config', (event, config) => {
    saveConfig(config);
    return { success: true };
  });
}

/**
 * 应用就绪
 */
app.whenReady().then(() => {
  initConfigDir();

  const config = readConfig();
  proxyEnabled = config.proxy.enabled || false;
  proxyPort = config.proxy.port || 7048;

  createMenuBar();
  createTray();
  createWindow();
  registerIpcHandlers();

  // 如果配置中启用了代理，自动启动
  if (proxyEnabled) {
    toggleProxy().catch(error => {
      console.error('[Electron] 自动启动代理失败:', error);
    });
  }
});

/**
 * 所有窗口关闭
 */
app.on('window-all-closed', () => {
  // macOS 上保留应用运行
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

/**
 * 应用激活 (macOS)
 */
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

/**
 * 应用退出前
 */
app.on('before-quit', async () => {
  if (proxyServer) {
    const { stopProxy } = await import('../server/index.js');
    await stopProxy();
  }
});
