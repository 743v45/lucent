## Why

继 2026-07-19 修复 8 条 high（commit f906167）后，处理同次全量审查的剩余 medium / low（共 48 条）。其中约 5 条 SSE 相关（心跳容错 / 连接无上限 / 孤儿 interval / 背压）已被 high #2 / #5 的 `writeSse` / `destroySseClient` / `MAX_SSE_CLIENTS` 间接解决；1 条（路由鉴权中间件）改变本机工具使用方式，留作独立安全决策不在此批。本 change 批量修复其余约 41 条，覆盖：

- **可靠性**：shutdown 顺序（在途日志不丢）、config 原子写、drainWriteQueue timer 清理、tee abort 传播
- **健壮性**：log-reader JSON 解析防御、EventSource 错误处理、loadThread 迭代上限
- **性能**：prepared statement 复用、DetailPanel / MarkdownContent / ContextListItem memo、nowTick / settingsValue 引用稳定、拖拽节流、group-by-thread 二分 + 预计算
- **正确性**：archiveOnly 空态、proxyPort 硬编码、api headers 合并击穿、mapErrorToStatus 脆弱正则
- **清理**：useProxyStatus 死代码、接入地址 / ProviderIcon / 命中率配色重复、内联 style 违规
- **可维护性**：DetailPanel 1588 行按 Tab 拆分

## What Changes（按文件分组，9 组并发，组间无文件重叠）

### server-lifecycle — `server/index.ts` + `server/services/log-writer.ts` + `server/services/log-reader.ts`
- shutdown 顺序：先 `proxyServer.stop()`（停入口、等在途请求日志入队）再 `closeDb()`（#4）
- `compression({ filter })` 跳过 `text/event-stream`（#13）
- `drainWriteQueue` 的 setTimeout 在 race 结束后 clearTimeout（#5）
- `reconstructEntry` 的 `JSON.parse(b.request/b.response)` 包 try/catch，坏行跳过不炸整页（#6）

### server-db — `server/services/db.ts`
- `insertLogInner` / `listLogs` / `searchLogs` 预编译 prepared statement 并复用（#8）
- `deleteOldLogs` / `deleteExpiredLogs` 改子查询驱动 + 抽共享 helper（#7、low#4）
- `logs_fts` 改 external content（low#3，按需）
- `migrateFromJsonl` 的 `onProgress` 语义修正（low#5）

### server-proxy — `server/proxy.ts` + `server/interceptor.ts`
- 客户端断开时把 abort 传播到 tee 的 logBranch，避免上游被日志副支拖住最长 3 分钟（#1，承接 high #6 的 AbortController）

### server-routes — `server/routes/logs.ts` + `server/routes/providers.ts` + `server/body-rewriter.ts`
- `/api/logs` 的 `offset` 删除或 400（low#6）
- export / import 解构 `req.body ?? {}` null 守卫（low#7）
- `mapErrorToStatus` 改类型化错误（err.code）+ 抽共享 `httpStatusFromError`（#14）

### server-config — `server/config.ts`
- `saveConfig` 原子写（写 `.tmp` 再 `rename`）+ 顺序改为 validate→write→成功后才 commit cachedConfig（#11）

### fe-data — `src/hooks/useLogs.ts` + `src/utils/api.ts` + `src/utils/group-by-thread.ts`
- `visibleLogs` memo 在无 expiresAt 项时返回 logs 原引用（#22）
- EventSource 注册 `onerror` + 连接丢失状态（#25）
- `loadMore` catch 复用 setError（#27）
- `loadThread` do/while 加迭代上限 + 切换筛选重置已展开组（#28）
- `getLogs` 返回类型对齐运行时形状，移除 formatLog 的强制断言（#26）
- `request()` 先解构 headers 再合并，默认 Content-Type 不被击穿（low#12）
- `groupByThread` sub 归属改二分 + 预计算 timestamp 毫秒（low#10、low#13）

### fe-detailpanel — `src/components/viewer/DetailPanel.tsx`
- `MarkdownContent` components 映射上提模块级 + `useMemo`，`ContextListItem` / `ContextDetailCard` 包 `React.memo`（#16、#17）
- 1588 行按 Tab 拆到 `src/components/viewer/detail/{RequestTab,ResponseTab,KVCacheTab,ContextTab,MetaTab}.tsx` + `shared.tsx` + `utils.ts`（#19）
- 删 JsonBlock 冗余内联 style、命中率配色抽纯函数、clipboard 封装共享 `copyText`（#18、low#8、low#9）

### fe-list-app — `src/components/dashboard/LogListPanel.tsx` + `src/App.tsx`
- archiveOnly 空态用 `displayLogs` 判定 + 自动补拉在 archiveOnly 时跳过（#20）
- `LogListPanel` width 改 CSS 变量（low#11）
- Popover「环境变量锁定」重复提示删一份（#21）
- 侧栏拖拽改 ref + rAF 节流，`handleMouseMove/Up` 稳定引用（#23）
- `settingsValue` `useMemo` + `updatePreferences` `useCallback`（#24）

### fe-settings-common — `src/components/settings/SettingsModal.tsx` + `src/components/common/ProviderIcon.tsx` + `src/components/common/ClientIcon.tsx` + `src/hooks/useProxyStatus.ts` + `src/components/.../UsageGuide.tsx`
- SettingsModal 用真实 `proxyPort`（getProxyStatus）（#30）
- `handleDelete` / `handleRenameCommit` 改函数式 `prev =>`（#31）
- 接入地址抽共享 `buildAccessUrl`，SettingsModal 与 UsageGuide 共用（#33）
- `ProviderIcon` 单 lazy 加载表（mono/avatar 合一）（#34）
- `ClientIcon` 颜色内联 style → className 映射（#32）
- 删除死代码 `useProxyStatus.ts`（#29，先 grep 确认零引用）
- 测试失败 badge 用 Tooltip 显示完整 message（low#14）

## 不处理（留作独立决策）
- **路由鉴权中间件（审查 medium #15）**：改变本机工具使用方式（`0.0.0.0` 裸用 / token），路径穿越已修为主线防御。需要可另开 change 做轻量鉴权（回环校验 / 启动 token）。
- **SSE 心跳容错 / 连接无上限 / 孤儿 interval / 背压（medium #9 #10 #12、low #1）**：已被 high #2 / #5 解决，不重复。

## Capabilities
- `real-time-push`：SSE 响应 SHALL 不被 compression 缓冲（#13）
- `log-integrity`：`config.json` SHALL 原子写（#11）

## Impact
- 改动约 16 个源文件 + DetailPanel 拆分新增多文件；新增 / 更新对应测试
- 行为兼容：除「`/api/logs` offset 删/400」「Popover 去重」「接入地址端口修正」「DetailPanel 文件拆分」外，对正常用户无感
