## Why

2026-07-19 对 lucent（server + src，约 12k 行）做了一次 8-agent 并发全量审查，产出 56 条 finding（8 high / 34 medium / 14 low）。其中 8 条 high 已逐条人工复验属实（6 条亲自读源码确认、2 条代码一致），覆盖：安全（路径穿越）、可靠性（单坏连接拖垮整进程）、核心功能静默失效（分页超过 500 条失效）、资源泄漏（SSE 背压 / 上游悬挂）、性能（SSE 流每次重渲染重解析）、数据竞态（自动保存 last-write-wins 回滚）。

本 change 批量修复全部 8 条 high，使这些已识别缺陷不再潜伏。medium / low 留待后续按主题分批处理。

## What Changes

按文件归属分 5 组实施（组间无文件重叠，可并发）：

### A. SSE 与导出安全（#1 #2 #5）— `server/routes/logs.ts` + `server/log-manager.ts` + `server/sse-bus.ts`

- **#1 导出 / 导入路径穿越**：`POST /api/logs/export` 的 `format` 加白名单（仅 `jsonl` | `markdown`，否则 400）；文件名用 `path.basename` 净化，输出路径 resolve 后校验 `startsWith(logDir)`。`POST /api/logs/import` 的 `filePath` resolve 后 MUST `startsWith(logDir)`，否则 400。封堵任意文件读写 / 覆盖（含 `log-manager.ts:103` 的 `mkdirSync(dirname,{recursive:true})` 会主动建穿越目录 + `writeFileSync` 覆盖写）。
- **#2 SSE 心跳裸 write**：`connected` / `heartbeat` / `broadcastLog` 的所有 `res.write` 统一走 try/catch 容错（抽 `writeSse(res, payload)` 单点）；失败即 `clearInterval + unregisterSseClient + res.destroy`；每个 res 注册 `on('error')` 走同一清理。消除单坏连接 → `uncaughtException` → `process.exit(1)` 整进程重启。
- **#5 SSE 背压**：`broadcastLog` 处理 `res.write` 返回值——停滞客户端（持续背压）直接剔除 + destroy；`registerSseClient` 加连接数上限，超限 503。消除慢客户端内部缓冲无限堆积。

### B. 列表分页（#3 #4）— `src/hooks/useLogs.ts`

- **#3 loadMore TOCTOU 竞态**：用 `loadingMoreRef`（useRef）做 in-flight 去重绕开闭包陈旧；`loadMore` 的 reqId 改为自增（与 `loadLogs` 一致）；append 路径加按 id 去重（与 `addLog` 一致）。消除同 cursor 并发请求导致列表重复条目。
- **#4 软上限破坏分页**：`loadMore` 在 `combined.length > LOGS_SOFT_CAP` 裁剪时同步 `setHasMore(false)`，让「加载更多」到达软上限后如实消失。消除超过 500 条后「加载更多」静默无效。

### C. 代理转发超时（#6）— `server/proxy.ts`

- **#6 上游无超时 / 取消**：每次转发构造 `AbortController`，加响应头超时（默认 120s）+ 流式 idle 超时；`res.on('close')` 在客户端断开时 `controller.abort()` 取消未完成的上游 fetch；超时返回 504、客户端断开安全收尾。消除上游 stall 悬挂 + 客户端断开后上游配额空烧。

### D. 详情视图性能（#7）— `src/components/viewer/DetailPanel.tsx`

- **#7 InlineTokenStats 重解析**：在 DetailPanel 顶层 `useMemo` 解析一次 `tokenUsage`（依赖 `[log]`），作为 prop 传给 `InlineTokenStats`（包 `React.memo`）与 MetaTab。消除每次父组件重渲染（切 tab / 折叠 / 搜索防抖 / 自动刷新）都 O(n) 全量重解析整条 SSE 流。

### E. 设置自动保存竞态（#8）— `src/components/settings/SettingsModal.tsx`

- **#8 handleAutoSave last-write-wins**：按 provider 防抖（debounce 约 400ms）合并连续 endpoint 编辑为一次 PUT（或 AbortController 串行化，新 blur abort 上一次在途 PUT）。消除连续编辑多 endpoint 时后发更新被旧快照覆盖、静默回滚。

## Capabilities

- `real-time-push`：扩展 SSE 写容错、背压剔除、连接上限（#2 #5）
- `log-integrity`：扩展导出 / 导入路径安全校验（#1）
- `proxy-forwarding`（**新**）：上游请求超时与客户端断开取消（#6）

## Impact

- **改动文件**：`server/routes/logs.ts`、`server/log-manager.ts`、`server/sse-bus.ts`、`src/hooks/useLogs.ts`、`server/proxy.ts`、`src/components/viewer/DetailPanel.tsx`、`src/components/settings/SettingsModal.tsx`
- **新增测试**：每组带回归测试（路径校验、SSE 容错 / 背压、分页竞态、超时取消、防抖）
- **行为兼容**：除「加载更多到上限后按钮消失」「导出 format 非法返 400」「慢 SSE 客户端被剔除」外，对正常用户无感；转发、日志记录、UI 交互契约不变。
