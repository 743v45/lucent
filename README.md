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
- 🖥️ 跨平台桌面应用（macOS/Windows/Linux）
- 🎨 现代化 UI（React + Ant Design）

## 安装

```bash
npm install
```

## 开发

```bash
# 启动 Web 开发服务器
npm run dev

# 启动 Electron 应用（开发模式）
npm run electron:dev

# 仅启动代理服务器
npm run start:proxy
```

## 构建

```bash
# 构建 Web 资源
npm run build

# 构建 Electron 应用
npm run electron:build
```

## 架构

```
┌─────────────────┐
│  Electron 主进程  │ ← 菜单栏、系统托盘、进程管理
├─────────────────┤
│   React UI      │ ← 日志列表、详情面板、5个Tab视图
├─────────────────┤
│  代理服务器      │ ← HTTP代理、Fetch拦截、日志存储
└─────────────────┘
```

## 配置

配置文件位置：`~/.agentproxy/config.json`

```json
{
  "proxy": {
    "enabled": true,
    "port": 7048
  },
  "log": {
    "maxFileSize": 104857600,
    "retentionDays": 30
  }
}
```

## 设计文档

详见 [DESIGN.md](./DESIGN.md)

## 参考资料

基于 [cc-viewer](https://github.com/weiesky/cc-viewer) 项目架构

## License

MIT
