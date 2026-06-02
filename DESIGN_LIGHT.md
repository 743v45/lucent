# AgentProxy 轻量级设计

## 方案对比

| 方案 | 大小 | 优点 | 缺点 |
|------|------|------|------|
| **Electron** | ~200MB | 功能完整 | 太重 |
| **Tauri** | ~5MB | 轻量、安全 | 需要 Rust |
| **纯 Web** | ~2MB | 最轻量 | 需要手动启动 |
| **CLI + Web** | ~2MB | 灵活 | 命令行操作 |

## 推荐方案：纯 Web 应用

### 架构
```
┌─────────────────────────────────────────┐
│        本地代理服务器 (Node.js)           │
│  - HTTP 代理 (端口 7048)                 │
│  - Web UI (端口 7049)                    │
│  - WebSocket 推送                        │
│  - 日志存储                              │
└─────────────────────────────────────────┘
              ▲
              │ 浏览器访问
              │
   ┌──────────┴──────────┐
   │  http://localhost:7049 │
   │  React UI             │
   │  - 日志列表           │
   │  - 详情面板 (5个Tab)  │
   │  - 代理控制           │
   └──────────────────────┘
```

### 使用方式

```bash
# 启动代理 + Web UI
agentproxy start

# 访问界面
open http://localhost:7049

# 停止代理
agentproxy stop

# 查看状态
agentproxy status

# 查看日志
agentproxy logs
```

### 目录结构（精简版）

```
agentproxy/
├── bin/              # CLI 命令
│   └── cli.js        # 命令行入口
├── server/           # 代理服务器
│   ├── index.js      # 主服务器
│   ├── proxy.js      # HTTP 代理
│   └── routes.js     # API 路由
├── src/              # React UI（构建后到 dist/）
├── dist/             # 构建输出
├── logs/             # 日志文件（~/.agentproxy/logs）
└── package.json
```

### 核心变化

**删除：**
- ❌ electron/ 目录
- ❌ 桌面应用相关代码

**新增：**
- ✅ bin/cli.js - 命令行工具
- ✅ server 内置 Web UI 服务
- ✅ 自动打开浏览器

### 菜单栏替代方案

方案 1: **浏览器固定标签**
```
打开后提示：将此页固定为应用标签
- Chrome: 右键 → 固定标签页
- Safari: 添加到个人收藏
```

方案 2: **PWA (Progressive Web App)**
```
- 添加 manifest.json
- 支持离线访问
- 可安装到应用列表
```

方案 3: **系统托盘（可选）**
```
如果需要托盘，可以用 node-notifier 轻量实现
- 仅状态通知
- 无需完整桌面应用
```

---

## 要重写吗？

我可以立即重写为轻量级版本，需要确认：

1. **方案选择**：纯 Web（推荐）还是 Tauri（需要 Rust）？
2. **托盘需求**：是否需要系统托盘？
3. **启动方式**：CLI 命令启动还是双击运行？
