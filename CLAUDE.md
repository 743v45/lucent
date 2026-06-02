# AgentProxy 项目说明

## 项目概述

AgentProxy 是一个 AI Agent 代理服务器应用，用于拦截、记录和可视化 OpenAI/Claude API 通信内容。

## 核心功能

1. **代理拦截**
   - HTTP 代理模式
   - Fetch 全局拦截
   - 支持流式响应捕获

2. **通信记录**
   - Request: 完整的 API 请求内容
   - Response: 完整的 API 响应内容
   - KV-Cache-Text: 缓存相关信息
   - Context: 对话上下文

3. **Agent 识别**
   - 主 Agent (Main Agent): 完整对话的请求
   - 辅 Agent (Sub Agent): Plan/Search/Bash/Workflow 等子任务

4. **桌面应用**
   - 菜单栏控制
   - 系统托盘
   - 跨平台 (macOS/Windows/Linux)

## 技术栈

- **前端**: React 18 + Ant Design 5 + Vite
- **后端**: Node.js 20+ (ES Modules)
- **桌面**: Electron 33
- **样式**: Tailwind CSS + Ant Design 组件

## 开发指南

### 启动开发环境

```bash
# 安装依赖
npm install

# 启动 Web 开发服务器 (终端 1)
npm run dev

# 启动 Electron 应用 (终端 2)
npm run electron:dev
```

### 项目结构

```
agentproxy/
├── electron/          # Electron 主进程
│   ├── main.js       # 主进程入口
│   └── preload.js    # 预加载脚本
├── server/           # 代理服务器
│   └── index.js      # 服务器入口
├── src/              # React 源码
│   ├── components/   # UI 组件
│   │   ├── common/   # 通用组件
│   │   ├── dashboard/# 仪表盘
│   │   ├── viewer/   # 详情查看器
│   │   └── settings/# 设置
│   ├── contexts/     # React Context
│   ├── hooks/        # 自定义 Hooks
│   ├── utils/        # 工具函数
│   ├── App.jsx       # 应用入口
│   └── main.jsx      # React 入口
├── public/           # 静态资源
├── DESIGN.md         # 设计文档
└── package.json
```

### 禁止手写 CSS

所有样式必须使用：
- **Tailwind CSS** 工具类
- **Ant Design** 组件样式

禁止：
- ❌ 手写 `.css` 文件中的自定义样式
- ❌ `style={{}}` 内联样式
- ❌ CSS-in-JS 库

## 设计文档

详细设计见 [DESIGN.md](./DESIGN.md)

## 参考资料

参考项目: [cc-viewer](https://github.com/weiesky/cc-viewer)
