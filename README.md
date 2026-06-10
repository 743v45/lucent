# AgentProxy

<p align="center">
  <img src="./docs/screenshot.png" alt="AgentProxy Screenshot" width="800">
</p>

<p align="center">
  <strong>AI Agent 代理服务器</strong> — 拦截并可视化 OpenAI / Claude API 通信
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> · <a href="#cli-命令">CLI</a> · <a href="#功能特性">功能</a> · <a href="./DESIGN.md">设计文档</a>
</p>

---

## 功能特性

- 📡 **代理转发** — 透明拦截 OpenAI / Claude API 请求与响应
- 📝 **完整记录** — Request、Response、KV-Cache-Text、Context 全量捕获
- 🏷️ **Agent 识别** — 自动区分主 Agent（MainAgent）和子 Agent（SubAgent）
- ⚡ **实时推送** — SSE 流式更新，新日志即时呈现
- 🌐 **Web UI** — 纯浏览器访问，无需安装桌面客户端
- 🎨 **深色主题** — 护眼配色，长时间使用不疲劳

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
agentproxy status           # 查看状态
agentproxy logs             # 查看日志
agentproxy start -p 8080    # 指定端口启动
agentproxy start --no-open  # 不自动打开浏览器
```

## 界面说明

| 区域 | 功能 |
|------|------|
| 左侧日志列表 | 显示所有通信记录，包含 Agent 类型、耗时、状态码 |
| 右侧详情面板 | 展示选中记录的完整 Request / Response / Context 等信息 |
| 顶部导航栏 | 应用标题 + 操作按钮（刷新、关于、设置） |

## 项目结构

```
agentproxy/
├── bin/              # CLI 入口
├── server/           # Express 服务器 + 代理 + SSE 推送
├── src/              # React 前端 (Vite + TypeScript + Ant Design)
│   ├── components/   # UI 组件 (日志列表、详情面板等)
│   ├── contexts/     # React Context 状态管理
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
  "proxy": {
    "enabled": false,
    "port": 7048
  }
}
```

## License

MIT
