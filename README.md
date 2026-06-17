# Lucent

<p align="center">
  <img src="./docs/screenshot.png" alt="Lucent Screenshot" width="800">
</p>

<p align="center">
  <strong>AI Agent 透明代理</strong> — 穿透转发、全量记录、可视化 OpenAI / Claude API 通信
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> · <a href="#cli-命令">CLI</a> · <a href="#功能特性">功能</a> · <a href="./DESIGN.md">设计文档</a>
</p>

---

## 设计思路

Lucent 是一个 **透明代理**，位于 AI 客户端和上游 API 之间，零侵入地穿透并记录所有通信：

```
Claude Code / Cursor / 其他客户端
            │
            ▼
    ┌───────────────┐
    │  Lucent   │  ← 透明代理 (端口 7048)
    │  穿透 · 记录   │
    └───────┬───────┘
            │ 穿透到上游
            ▼
   Anthropic / OpenAI API
```

**核心理念：** 客户端只需将 API Base URL 指向本地代理端口，请求直接穿透上游，同时获得完整的通信可视化能力，无需修改任何业务代码。

## 功能特性

- 📡 **透明代理** — 穿透转发 OpenAI / Claude API 请求与响应
- 📝 **全量记录** — Request、Response、KV-Cache-Text、Context 完整捕获
- 🏷️ **Agent 识别** — 自动区分主 Agent（MainAgent）和子 Agent（SubAgent）
- 🔧 **预设供应商** — 内置官方/社区预设，一键配置 Anthropic、OpenAI、DeepSeek 等
- 🎯 **多维筛选** — 按供应商、协议筛选通信记录
- ⚡ **SSE 就绪** — SSE 推送端点已搭建，支持流式数据通道
- 🌐 **Web UI** — 纯浏览器访问，无需安装桌面客户端
- 🎨 **深色 UI** — Linear 风格暗色设计，长时间使用不疲劳

## 快速开始

```bash
npm install
npm start
# 浏览器自动打开 http://localhost:7049
```

## 使用方法

### 第一步：配置供应商

打开 Web UI → 右上角 ⚙️ 设置 → 点击「新增供应商」：

1. **命名**：给供应商一个名字（如 `glm`、`deepseek`、`claude`），只允许字母、数字、下划线、短横线
2. **填 API Key**：供应商的认证密钥
3. **填端点 URL**：按供应商支持的协议填写对应地址（可只填一个）：
   - **Anthropic Messages**：如 `https://api.anthropic.com/v1`（Claude 系列）
   - **OpenAI Chat**：如 `https://api.openai.com/v1` 或 `https://api.deepseek.com/v1`
   - **OpenAI Responses**：如 `https://api.openai.com/v1`（OpenAI 新 Responses API）

> 💡 **提示**：未配置的协议端点访问时会返回 404。比如只填了 Anthropic Messages，访问 `/custom/glm/v1/chat/completions` 会报错。

### 第二步：接入下游客户端

Lucent 是透明代理，请求只过一道——客户端接哪个供应商就走哪个。把客户端的 Base URL 指向本代理即可。

**路径规则**（`custom/` 前缀仅自定义供应商需要，预设供应商直接用供应商名）：

| 协议 | 下游 Base URL（环境变量） | 下游接入路径 | 上游 Base URL（示例）+ 补全路径 |
|------|--------------------------|-------------|-------------------------------|
| Anthropic Messages | `http://127.0.0.1:7048/custom/hxy2` | `…/custom/hxy2/v1/messages` | `https://api.anthropic.com/v1` + `/messages` |
| OpenAI Chat | `http://127.0.0.1:7048/custom/hxy2/v1` | `…/custom/hxy2/v1/chat/completions`（兼容不带 `/v1`） | `https://api.openai.com/v1` + `/chat/completions` |
| OpenAI Responses | `http://127.0.0.1:7048/custom/hxy2/v1` | `…/custom/hxy2/v1/responses`（兼容不带 `/v1`） | `https://api.openai.com/v1` + `/responses` |

> 上例用自定义供应商 `hxy2` 演示；预设供应商去掉 `custom/` 前缀（如 `http://127.0.0.1:7048/anthropic`）。上游 Base URL 由各供应商配置决定（DeepSeek 是 `https://api.deepseek.com/v1`，其他平台各不相同），上表 OpenAI 官方仅为示例。

```bash
# Anthropic 协议（Claude Code 等）
export ANTHROPIC_BASE_URL=http://127.0.0.1:7048/custom/hxy2

# OpenAI 协议（Codex / OpenAI 客户端，末尾加 /v1）
export OPENAI_BASE_URL=http://127.0.0.1:7048/custom/hxy2/v1
```

> 应用内的 **使用说明** 弹窗会根据你配置的供应商自动生成可复制的 `export` 命令。

## CLI 命令

```bash
lucent start            # 启动服务器
lucent stop             # 停止服务器
lucent status           # 查看状态
lucent logs             # 查看日志
lucent start -p 8080    # 指定端口启动
lucent start --open     # 启动后自动打开浏览器
```

## 界面说明

| 区域 | 功能 |
|------|------|
| 左侧日志列表 | 显示所有通信记录，支持按供应商/协议筛选，包含 Agent 类型、耗时、状态码 |
| 右侧详情面板 | 展示 Request / Response / KV-Cache / Context / Meta 五个 Tab |
| 顶部导航栏 | 应用标题 + 操作按钮（刷新、使用说明、配置） |

## 项目结构

```
lucent/
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

### 测试

```bash
npm run test:run       # 跑全量 vitest 单测/e2e 套件
npm run verify:e2e     # 启动真后端 + mock 上游的端到端验收
```

### 端到端验收

**何时跑**：任何改动 URL 拼接、请求路由、provider 模型、协议处理、首次启动默认值的代码后，**必须**跑 `npm run verify:e2e` 才能算完成。这是 [`openspec/specs/verification-workflow`](openspec/specs/verification-workflow/spec.md) 第 3 条 Requirement 的落地工具。

```bash
npm run verify:e2e
```

脚本会：
1. 在临时目录创建隔离配置（不碰 `~/.lucent/config.json`）+ 随机端口启动 mock 上游
2. spawn 真后端进程（`npx tsx server/index.ts`）
3. 发真实 HTTP 请求穿越 proxy → mock 上游，断言上游收到的内容
4. 覆盖 12 个场景：预设供应商三种协议转发 + 自定义供应商（带/不带 `/v1`）+ 测试连接三种协议 + 三种 404 边界 + 测试连接 vs 代理转发路径一致性

**怎么看**：
- ✅ `14/14 通过, 0 失败` + 退出码 `0` = 绿
- ❌ 任何 `✗ FAIL` + 非 0 退出码 = 红，失败项会标出实际值

脚本对应 [`openspec/specs/e2e-verification`](openspec/specs/e2e-verification/spec.md)（spec 化的验收契约）。

### 协议链路验收（含 Web UI 渲染）

`verify:e2e` 只覆盖路由/URL 拼接层。**协议格式 + 日志 + API + Web UI 渲染**这条完整链路需要更深的验收：

```bash
npm run verify:anthropic       # anthropic-messages 全链路（流式 SSE + 非流式 JSON × 5 环节 × UI）
npm run verify:openai-chat     # openai-chat 同样覆盖
npm run verify:openai-responses # openai-responses 同样覆盖（注意：请求用 input 不是 messages）
npm run verify:custom           # 自定义供应商(hxy + hxy2) 配齐 3 协议 × 5 环节 = 60 验收点
```

每条命令启动真后端 + vite dev + mock 上游 + playwright headless 浏览器，断言 10-60 个验收点（含 Web UI data-testid 渲染匹配）。`verify:custom` 用 1 个 mock upstream 同时处理 3 协议，遍历 2 个自定义供应商 × 3 协议 × 2 模式。

契约见 [`openspec/specs/protocol-chain-verification`](openspec/specs/protocol-chain-verification/spec.md)。

## 参考

本项目参考了 [cc-viewer](https://github.com/weiesky/cc-viewer) 的功能交互与页面排版设计。

## License

MIT
