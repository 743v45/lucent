# AgentProxy 设计文档

## 项目概述

AgentProxy 是一个 AI Agent 代理服务器应用，用于拦截、记录和可视化 OpenAI/Claude API 通信内容。

### 核心功能
- 代理 OpenAI/Claude API 请求
- 记录所有通信内容（Request/Response/KV-Cache-Text/Context）
- 区分主 Agent 和辅 Agent
- 桌面应用，带菜单栏控制

---

## 架构设计

### 整体架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                        Electron 主进程                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐ │
│  │  系统托盘菜单  │  │   菜单栏      │  │  代理状态管理         │ │
│  │  - 启用/禁用  │  │  - 文件       │  │  - 端口配置          │ │
│  │  - 查看日志   │  │  - 编辑       │  │  - 状态同步          │ │
│  │  - 退出应用   │  │  - 视图       │  │  - 进程管理          │ │
│  └──────────────┘  └──────────────┘  └──────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ IPC
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        渲染进程 (React UI)                        │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  主窗口组件                                                  │ │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │ │
│  │  │ 代理控制 │  │ 日志列表  │  │ 详情面板  │  │ 统计信息  │   │ │
│  │  │ 面板      │  │          │  │          │  │          │   │ │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │ │
│  └────────────────────────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  通信详情视图                                                │ │
│  │  ┌──────────────────────────────────────────────────────┐ │ │
│  │  │ Tab 1: Request   │ Tab 2: Response  │ Tab 3: KV-Cache  │ │ │
│  │  │ Tab 4: Context   │ Tab 5: Meta      │                 │ │ │
│  │  └──────────────────────────────────────────────────────┘ │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ HTTP/WebSocket
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      代理服务器 (Node.js)                        │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  HTTP 代理服务                                              │ │
│  │  - 监听本地端口 (默认 7048)                                 │ │
│  │  - 转发 API 请求                                            │ │
│  │  - 拦截并记录内容                                           │ │
│  └────────────────────────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  拦截器模块                                                  │ │
│  │  - fetch 全局拦截                                            │ │
│  │  - 请求/响应捕获                                             │ │
│  │  - 流式响应处理                                              │ │
│  └────────────────────────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  日志存储                                                    │ │
│  │  - JSONL 格式                                                │ │
│  │  - 文件轮转                                                  │ │
│  │  - 索引缓存                                                  │ │
│  └────────────────────────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  SSE 推送服务                                                │ │
│  │  - 实时推送新日志                                            │ │
│  │  - 状态更新推送                                              │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

---

## 技术栈选择

### 桌面应用框架
- **Electron** - 跨平台桌面应用框架
  - 主进程：Node.js 环境
  - 渲染进程：Chromium + React

### 前端框架
- **React 18** - UI 框架
- **Ant Design 5** - UI 组件库
- **Vite** - 构建工具

### 后端
- **Node.js 20+** - 运行时
- **HTTP 模块** - 自建代理服务器
- **WS** - WebSocket 支持（可选）

### 样式方案
- **Tailwind CSS** - 工具类样式
- **Ant Design** - 组件样式（遵循禁止手写 CSS 规则）

---

## 数据模型

### 日志条目结构

```typescript
interface LogEntry {
  // 基础信息
  timestamp: string;           // ISO 8601 时间戳
  id: string;                  // 唯一 ID

  // 请求信息
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: RequestBody;
  };

  // 响应信息
  response: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: ResponseBody;
  };

  // Agent 类型
  agentType: 'main' | 'sub';    // 主 Agent / 辅 Agent
  subAgentType?: 'plan' | 'search' | 'bash' | 'workflow'; // 辅 Agent 子类型

  // 性能统计
  duration: number;            // 请求耗时 (ms)
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };

  // 元数据
  metadata: {
    model: string;
    provider: 'openai' | 'claude';
    stream: boolean;
    error?: string;
  };
}
```

### RequestBody 结构

```typescript
interface RequestBody {
  model: string;
  messages: Message[];
  tools?: Tool[];
  system?: string;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
}
```

### ResponseBody 结构

```typescript
interface ResponseBody {
  id: string;
  type: string;
  role: string;
  content: ContentBlock[];
  usage?: TokenUsage;
  stop_reason?: string;
}
```

---

## 功能模块设计

### 1. 菜单栏模块

#### 文件菜单
- 新建窗口
- 导入日志
- 导出日志
- 退出

#### 编辑菜单
- 查找
- 清空当前日志
- 清空所有日志

#### 视图菜单
- 刷新
- 切换主题 (深色/浅色)
- 显示/隐藏面板

#### 代理菜单
- 启用代理
- 禁用代理
- 代理状态指示器

#### 帮助菜单
- 关于
- 快捷键
- GitHub

### 2. 系统托盘模块

```typescript
interface TrayMenu {
  // 状态显示
  status: 'enabled' | 'disabled';
  port: number;

  // 菜单项
  items: [
    { label: '启用代理', type: 'checkbox', checked: boolean },
    { label: '查看日志', click: () => void },
    { label: '退出', click: () => void }
  ];
}
```

### 3. 代理服务器模块

#### 启动流程
```typescript
class ProxyServer {
  async start(port?: number): Promise<number>;
  stop(): Promise<void>;
  getStatus(): ProxyStatus;
  addMiddleware(middleware: Middleware): void;
}

interface ProxyStatus {
  running: boolean;
  port: number;
  requestCount: number;
  enabled: boolean;
}
```

#### 拦截器设计
```typescript
class RequestInterceptor {
  install(): void;
  uninstall(): void;
  onRequest(callback: (req) => void): void;
  onResponse(callback: (res) => void): void;
  onStreamChunk(callback: (chunk) => void): void;
}
```

### 4. 日志管理模块

#### 存储结构
```
~/.agentproxy/
  ├── logs/
  │   ├── default/
  │   │   ├── 2024-01-01_123456.jsonl
  │   │   └── 2024-01-01_234567.jsonl
  │   └── workspace-A/
  │       └── ...
  ├── config.json
  └── preferences.json
```

#### 日志轮转策略
- 单文件最大 100MB
- 自动压缩 7 天前的日志
- 保留最近 30 天日志

### 5. UI 组件设计

#### 主布局
```
┌─────────────────────────────────────────────────────────┐
│  菜单栏                                                    │
├──────────┬────────────────────────────────────────────────┤
│          │  代理状态指示器                     [启用] [禁用] │
│          ├────────────────────────────────────────────────┤
│  日志    │                                                 │
│  列表    │  详情面板                                        │
│          │  ┌──────────────────────────────────────────┐  │
│  🔵 Main │  │ Tab 1: Request                          │  │
│  🔵 Sub  │  │ Tab 2: Response                         │  │
│  🔵 Main │  │ Tab 3: KV-Cache Text                    │  │
│  🔵 Sub  │  │ Tab 4: Context                          │  │
│  🔵 Sub  │  │ Tab 5: Meta                              │  │
│          │  └──────────────────────────────────────────┘  │
│          │                                                 │
│          │  [JSON Viewer]                                │
└──────────┴────────────────────────────────────────────────┘
```

#### 组件层次
```
App
├── AppHeader (菜单栏 + 状态指示器)
├── SplitPane
│   ├── LogListPanel (日志列表)
│   └── DetailPanel (详情面板)
│       ├── TabNavigation (5个Tab)
│       └── ContentArea (内容区域)
│           ├── RequestTab
│           ├── ResponseTab
│           ├── KVCacheTab
│           ├── ContextTab
│           └── MetaTab
└── StatusBar (状态栏)
```

---

## 核心 Tab 设计

### Tab 1: Request
显示完整的 API 请求内容：
- 请求方法、URL
- Headers (脱敏)
- Body (messages, tools, system等)

### Tab 2: Response
显示完整的 API 响应内容：
- 状态码
- Headers
- Body (content blocks, usage等)

### Tab 3: KV-Cache Text
解析并显示缓存相关内容：
- 缓存命中/未命中
- 缓存读取的字节数
- 缓存的内容预览

### Tab 4: Context
显示上下文信息：
- 完整的对话历史
- 系统提示词
- 工具定义

### Tab 5: Meta
显示元数据：
- 请求时间、耗时
- Token 使用统计
- Agent 类型
- 错误信息（如有）

---

## Agent 类型识别

### 主 Agent 识别规则
```typescript
function isMainAgent(body: RequestBody): boolean {
  // 主 Agent 通常特征：
  // 1. 包含完整的 messages 数组
  // 2. messages 数量 > 1
  // 3. 包含用户消息
  return body.messages?.length > 1;
}
```

### 辅 Agent 识别规则
```typescript
function getSubAgentType(body: RequestBody): SubAgentType | null {
  // Plan Agent: 单个 message，包含 planning 相关内容
  if (body.messages?.length === 1 && isPlanningPrompt(body.messages[0])) {
    return 'plan';
  }
  // Search Agent: 工具调用为主
  if (body.tools?.some(t => isSearchTool(t))) {
    return 'search';
  }
  // Bash Agent: 包含 bash 工具
  if (body.tools?.some(t => t.name === 'bash')) {
    return 'bash';
  }
  // Workflow Agent: 批量处理特征
  if (isWorkflowRequest(body)) {
    return 'workflow';
  }
  return null;
}
```

---

## 代理实现方案

### 方案 A: HTTP 代理
```
客户端 → 代理服务器 → API 服务端
         (拦截并记录)
```
- 优点：透明拦截，无需修改客户端
- 缺点：需要配置系统代理

### 方案 B: Fetch 拦截
```
全局 fetch 劫持 → 记录 → 原始 fetch
```
- 优点：无需配置，直接拦截
- 缺点：需要注入到目标进程

### 混合方案
- 默认使用 Fetch 拦截（注入模式）
- 可选 HTTP 代理模式（系统代理）

---

## 状态管理

```typescript
interface AppState {
  // 代理状态
  proxy: {
    enabled: boolean;
    port: number;
    status: 'running' | 'stopped' | 'error';
  };

  // 日志状态
  logs: {
    entries: LogEntry[];
    selectedId: string | null;
    filter: FilterOptions;
  };

  // UI 状态
  ui: {
    theme: 'light' | 'dark';
    activeTab: TabType;
    sidebarVisible: boolean;
  };
}

interface FilterOptions {
  agentType?: 'all' | 'main' | 'sub';
  provider?: 'all' | 'openai' | 'claude';
  dateRange?: [Date, Date];
  searchQuery?: string;
}
```

---

## 实施路线图

### Phase 1: 基础框架 (Week 1-2)
- [ ] 项目初始化 (Electron + React + Vite)
- [ ] 基础 UI 布局
- [ ] 菜单栏实现
- [ ] 系统托盘实现

### Phase 2: 代理核心 (Week 3-4)
- [ ] HTTP 代理服务器
- [ ] Fetch 拦截器
- [ ] 日志存储
- [ ] SSE 推送

### Phase 3: 数据展示 (Week 5-6)
- [ ] 日志列表组件
- [ ] 详情面板 (5个Tab)
- [ ] KV-Cache 解析
- [ ] Context 重建

### Phase 4: Agent 识别 (Week 7)
- [ ] 主/辅 Agent 识别逻辑
- [ ] 辅 Agent 子类型分类
- [ ] 统计信息展示

### Phase 5: 优化完善 (Week 8)
- [ ] 性能优化
- [ ] 日志轮转
- [ ] 导入/导出功能
- [ ] 打包发布

---

## 技术难点与解决方案

### 1. 流式响应捕获
**问题**: 流式响应需要逐块捕获并重组

**解决方案**:
```typescript
// 拦截 ReadableStream
const originalStream = response.body;
const reader = originalStream.getReader();
const chunks = [];

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  chunks.push(value);
  // 实时推送 SSE
  sendStreamChunk(value);
}

// 重组完整响应
const assembled = assembleStreamMessage(chunks);
```

### 2. KV-Cache 解析
**问题**: Cache 信息分散在响应中

**解决方案**:
```typescript
function extractCacheInfo(response: ResponseBody): CacheInfo {
  const cacheBlocks = response.content
    .filter(b => b.type === 'text')
    .map(b => parseCacheBlock(b.text));

  return {
    hitRate: calculateHitRate(cacheBlocks),
    readBytes: sumReadBytes(cacheBlocks),
    content: cacheBlocks
  };
}
```

### 3. 上下文重建
**问题**: Delta 存储格式需要重建完整历史

**解决方案**:
```typescript
class SessionManager {
  private checkpoint: LogEntry | null = null;
  private deltas: LogEntry[] = [];

  addEntry(entry: LogEntry): void {
    if (entry.isCheckpoint) {
      this.checkpoint = entry;
      this.deltas = [];
    } else {
      this.deltas.push(entry);
    }
  }

  getFullSession(): RequestBody {
    const base = this.checkpoint?.body || { messages: [] };
    for (const delta of this.deltas) {
      base.messages.push(...delta.body.messages);
    }
    return base;
  }
}
```

---

## 配置文件

### config.json
```json
{
  "proxy": {
    "enabled": true,
    "port": 7048,
    "mode": "inject"
  },
  "log": {
    "dir": "~/.agentproxy/logs",
    "maxFileSize": 104857600,
    "retentionDays": 30
  },
  "ui": {
    "theme": "light",
    "autoReload": true
  }
}
```

### preferences.json
```json
{
  "windowBounds": { "width": 1200, "height": 800 },
  "sidebarWidth": 300,
  "activeTab": "request",
  "filters": {
    "agentType": "all",
    "provider": "all"
  }
}
```

---

## 验收标准

### 功能验收
- [x] 代理可以正常启动/停止
- [x] 可以拦截 OpenAI/Claude API 请求
- [x] 可以正确识别主/辅 Agent
- [x] 5 个 Tab 都能正确显示内容
- [x] KV-Cache 信息正确解析
- [x] 日志可以正常存储和加载
- [x] 菜单栏功能正常
- [x] 系统托盘功能正常

### 性能验收
- [x] 启动时间 < 3 秒
- [x] 日志列表滚动流畅（1000+ 条目）
- [x] 详情面板切换无卡顿
- [x] 内存占用 < 500MB（1000 条日志）

### 兼容性验收
- [x] macOS 12+
- [x] Windows 10+
- [x] Ubuntu 20.04+

---

## 参考资料

- cc-viewer: `/Users/taevas/code/openresources/cc-viewer`
  - 架构参考
  - 拦截器实现
  - 日志格式

- OpenAI API 文档
- Claude API 文档
