# AgentProxy

<p align="center">
  <img src="./docs/screenshot.png" alt="AgentProxy Screenshot" width="800">
</p>

<p align="center">
  <strong>AI Agent 中转代理</strong> — 透明拦截、记录、可视化 OpenAI / Claude API 通信
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> · <a href="#cli-命令">CLI</a> · <a href="#功能特性">功能</a> · <a href="./DESIGN.md">设计文档</a>
</p>

---

## 设计思路

AgentProxy 是一个 **API 中转站**，位于 AI 客户端和上游 API 之间，零侵入地拦截所有通信：

```
Claude Code / Cursor / 其他客户端
            │
            ▼
    ┌───────────────┐
    │  AgentProxy   │  ← 中转代理 (端口 7048)
    │  拦截 · 记录   │
    └───────┬───────┘
            │ 转发到上游
            ▼
   Anthropic / OpenAI API
```

**核心理念：** 客户端只需将 API Base URL 指向本地代理端口，即可获得完整的通信可视化能力，无需修改任何业务代码。

## 功能特性

- 📡 **代理转发** — 透明拦截 OpenAI / Claude API 请求与响应
- 📝 **完整记录** — Request、Response、KV-Cache-Text、Context 全量捕获
- 🏷️ **Agent 识别** — 自动区分主 Agent（MainAgent）和子 Agent（SubAgent）
- ⚡ **SSE 就绪** — SSE 推送端点已搭建，支持流式数据通道
- 🌐 **Web UI** — 纯浏览器访问，无需安装桌面客户端
- 🎨 **深色 UI** — Linear 风格暗色设计，长时间使用不疲劳

## 快速开始

```bash
# 安装依赖
npm install

# 启动服务器
npm start

# 浏览器打开 http://localhost:7049
```

## CLI 命令

```bash
agentproxy start            # 启动服务器
agentproxy stop             # 停止服务器
agentproxy status           # 查看状态
agentproxy logs             # 查看日志
agentproxy start -p 8080    # 指定端口启动
agentproxy start --no-open  # 不自动打开浏览器
```

## 界面说明

| 区域 | 功能 |
|------|------|
| 左侧日志列表 | 显示所有通信记录，包含 Agent 类型、耗时、状态码 |
| 右侧详情面板 | 展示 Request / Response / KV-Cache / Context / Meta 五个 Tab |
| 顶部导航栏 | 应用标题 + 操作按钮（刷新、使用说明、配置） |

## 项目结构

```
agentproxy/
├── bin/              # CLI 入口
├── server/           # Express 服务器 + 代理 + SSE 推送
├── src/              # React 前端 (Vite + TypeScript + Ant Design)
│   ├── components/   # UI 组件 (日志列表、详情面板等)
│   ├── contexts/     # React Context 状态管理
│   ├── hooks/        # 自定义 Hooks (useLogs, useProxyStatus 等)
│   ├── utils/        # 工具函数 (API 请求、SSE 提取等)
│   └── types.ts      # 类型定义
├── dist/             # 构建输出
└── package.json
```

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 19 · Ant Design 6 · Tailwind CSS 4 · Vite 6 |
| 后端 | Node.js 20+ · Express · WebSocket (ws) |
| 构建 | TypeScript · tsx · Vite |
| 测试 | Vitest |

## 开发

```bash
npm install     # 安装依赖
npm run dev     # 启动开发服务器 (HMR)
npm run build   # 构建生产版本
```

## 配置

配置文件：`~/.agentproxy/config.json`

```json
{
  "proxyPort": 7048,
  "webPort": 7049,
  "groups": [
    {
      "name": "anthropic-messages",
      "match": "/v1/messages"
    }
  ]
}
```

## 参考

本项目参考了 [cc-viewer](https://github.com/weiesky/cc-viewer) 的功能交互与页面排版设计。

## License

MIT
