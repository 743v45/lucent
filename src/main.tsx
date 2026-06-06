import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import App from './App';
import { ROOT_ELEMENT_ID, THEME_PRIMARY_COLOR } from './constants';
import './index.css';

console.log('[main.tsx] Starting...');

const rootElement = document.getElementById(ROOT_ELEMENT_ID);

if (!rootElement) {
  console.error('[main.tsx] Root element not found!');
  document.body.innerHTML = '<h1 style="color:red;text-align:center;padding:50px;">错误：找不到 root 元素</h1>';
} else {
  console.log('[main.tsx] Root element found');

  try {
    const root = ReactDOM.createRoot(rootElement);
    console.log('[main.tsx] Root created');

    root.render(
      <React.StrictMode>
        <ConfigProvider
          locale={zhCN}
          theme={{
            algorithm: theme.darkAlgorithm,
            token: {
              colorPrimary: THEME_PRIMARY_COLOR,
            },
          }}
        >
          <App />
        </ConfigProvider>
      </React.StrictMode>
    );

    console.log('[main.tsx] Render complete');
  } catch (error) {
    console.error('[main.tsx] Render failed:', error);
    rootElement.innerHTML = `
      <div style="padding:50px;text-align:center;">
        <h1 style="color:red;">应用加载失败</h1>
        <pre style="background:#f5f5f5;padding:20px;border-radius:8px;overflow:auto;">${error}</pre>
      </div>
    `;
  }
}
