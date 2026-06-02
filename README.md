# AgentProxy

AI Agent 代理服务器 - 拦截并可视化 OpenAI/Claude API 通信

## 功能特性

- 📡 代理 OpenAI/Claude API 请求
- 📝 记录所有通信内容
  - Request
  - Response
  - KV-Cache-Text
  - Context
- 🔍 区分主 Agent 和辅 Agent
- 🌐 纯 Web 界面，无需安装
- ⚡ TypeScript + React + Ant Design

## 快速开始

```bash
# 安装依赖
npm install

# 启动服务器
npm start

# 访问 http://localhost:7049
```

## CLI 命令

```bash
# 启动服务器
agentproxy start

# 查看状态
agentproxy status

# 查看日志
agentproxy logs

# 指定端口启动
agentproxy start -p 8080

# 不自动打开浏览器
agentproxy start --no-open
```

## 开发

```bash
# 安装依赖
npm install

# 启动开发服务器
npm run dev

# 构建
npm run build
```

## 架构

```
┌─────────────────────────────────────────┐
│        本地服务器 (Node.js + Express)    │
│  - Web UI 服务 (端口 7049)              │
│  - API 接口                             │
│  - WebSocket 推送                        │
│  - 日志存储 (~/.agentproxy/logs)        │
└─────────────────────────────────────────┘
              ▲
              │ 浏览器访问
              │
   ┌──────────┴──────────┐
   │  http://localhost:7049 │
   │  React + TypeScript UI │
   │  - 日志列表           │
   │  - 详情面板 (5个Tab)  │
   │  - 代理控制           │
   └──────────────────────┘
```

## 项目结构

```
agentproxy/
├── bin/              # CLI 命令
│   └── cli.ts
├── server/           # 服务器
│   └── index.ts
├── src/              # React UI
│   ├── components/
│   │   ├── dashboard/
│   │   └── viewer/
│   ├── contexts/
│   ├── types.ts
│   ├── App.tsx
│   └── main.tsx
├── dist/             # 构建输出
└── package.json
```

## 配置

配置文件位置：`~/.agentproxy/config.json`

```json
{
  "proxy": {
    "enabled": false,
    "port": 7048
  },
  "ui": {
    "theme": "light"
  }
}
```

## 设计文档

详见 [DESIGN.md](./DESIGN.md)

## License

MIT
