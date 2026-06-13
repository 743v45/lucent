# KV-Cache 设计文档

> 最后更新：2026-06-13（审查优化轮次）
> 范围：代理服务器对 Claude / OpenAI 响应的缓存信息解析、口径计算与前端展示。

---

## 1. 概述

KV-Cache 面板用于呈现单次请求的**缓存命中情况**：命中率、读/写 token、未缓存 token、缓存命中的内容块（工具 / 系统提示词 / 消息），以及上下文窗口占用。

支持两种缓存协议：
- **explicit（Anthropic 显式缓存）**：请求体含 `cache_control` 标记，`usage` 含 `cache_creation_input_tokens` / `cache_read_input_tokens`。
- **auto（OpenAI 自动缓存）**：无显式标记，`usage.prompt_tokens_details.cached_tokens` 表示命中读取。

---

## 2. 模块架构

| 模块 | 职责 |
|------|------|
| [`server/kvcache.ts`](server/kvcache.ts) | 核心解析器。`extractCachedContent` 输出口径化结果；`getContextSizeForModel` 按模型返回 200K / 1M。 |
| [`server/services/log-reader.ts`](server/services/log-reader.ts) | `buildContextFromRequest` 调用解析器，写入 `log.kvCache` 与 `log.context.contextWindow`。 |
| [`server/log-manager.ts`](server/log-manager.ts) | `convertToMarkdown` 导出 Markdown（Token 字段）。 |
| [`server/types.ts`](server/types.ts) | `LogEntry.tokenUsage` / `KVCacheInfo` / `KVCacheBlock` 类型契约。 |
| [`src/components/viewer/DetailPanel.tsx`](src/components/viewer/DetailPanel.tsx) | KV-Cache Tab + 头部 InlineTokenStats 展示。 |

---

## 3. 数据流（关键：tokenUsage 全程 snake_case）

```
拦截器 extractTokenUsage ──► entry.tokenUsage (snake)
   │   { input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens }
   ▼
log-reader.normalizeLogEntry ──► 透传 snake
   ▼
buildContextFromRequest
   ├─ normalizedUsage = tokenUsage(safe) 或 response.body.usage(fallback)
   ├─ cached = extractCachedContent(body, normalizedUsage, { endpointType, provider })
   ├─ log.kvCache       ← cached.{hitRate, cacheReadTokens, status, cacheMode, ...}
   └─ log.context.contextWindow ← cached.totalInputTokens + output
   ▼
前端 DetailPanel（resolveTokenUsage 读 snake / KVCacheTab 读 kvCache）
```

**契约**：`LogEntry.tokenUsage` 与 `RawLogEntry.tokenUsage`、前端 `src/types.ts TokenUsage`、`test-utils.ts` **全部 snake_case**。

---

## 4. 核心口径定义

### 4.1 命中率 hitRate
```
hitRate = round(cacheReadTokens / totalInputTokens × 100)
```
仅看**命中读**，不含 cache_creation（creation 是首次写入，下次才变 read）。

### 4.2 totalInputTokens（按 provider 分支）
- **Anthropic**：`input_tokens + cache_creation_input_tokens + cache_read_input_tokens`
  （Anthropic 的 `input_tokens` 不含 cache，须显式累加）
- **OpenAI**：`prompt_tokens`（已含 `cached_tokens`，**不可**再叠加，否则重复计算）

### 4.3 contextWindow.totalTokens
```
totalTokens = cached.totalInputTokens + output_tokens
```
复用 KV-Cache 已算好的 `totalInputTokens`，保证两处面板**口径一致**。缓存部分同样占用上下文窗口（缓存只省费用/延迟，不省窗口）。

### 4.4 status 四态
| 条件 | status |
|------|--------|
| `cacheReadTokens > 0` | `hit` |
| `cacheCreateTokens > 0` | `first-create` |
| `cacheMode === 'none'` | `unsupported` |
| 否则（支持缓存但本次无数据） | `no-data` |

### 4.5 contextSize（分母自适应）
`getContextSizeForModel(model)`：匹配 `/opus|mythos|sonnet-4|claude-4/` → 1M，否则 200K。

---

## 5. 本次优化清单（2026-06-13）

### 🔴 P0 — 功能正确性

| # | 问题 | 修复 | 位置 |
|---|------|------|------|
| 1 | 导出 Markdown 的 Token 字段全 `undefined`（类型 camelCase 撒谎，数据 snake） | `LogEntry.tokenUsage` 类型统一 snake；`convertToMarkdown` 按 snake 读取 | [`types.ts`](server/types.ts#L108) / [`log-manager.ts`](server/log-manager.ts#L411) |
| 2 | `contextWindow.totalTokens` 漏算 cache（仅取 `input_tokens`） | 复用 `cached.totalInputTokens` | [`log-reader.ts`](server/services/log-reader.ts#L229) |

### 🟡 P1 — 一致性 / 代码健康

| # | 问题 | 修复 |
|---|------|------|
| 3 | `buildContextWindowEvent` / `parseModelBaseName` 死代码（零调用） | 删除函数 + 同步删测试 |
| 4 | InlineTokenStats 命中率阈值 hardcode `70/30` | 改用 `CACHE_HIT_RATE_GOOD_THRESHOLD` / `CACHE_HIT_RATE_BAD_THRESHOLD` |
| 5 | cache 命名三套混用（cacheWriteTokens / cache_creation_tokens / cacheCreateTokens） | `LogEntry.tokenUsage` 统一 snake，消除 `cacheWriteTokens` |

### 🟢 P2 — 精度 / 健壮性

| # | 问题 | 修复 |
|---|------|------|
| 6 | `estimateTokens` 对中文低估约 2–4 倍（`length/4`） | 区分 CJK（≈1.5 字符/token）与 ASCII（≈4 字符/token） |
| 7 | `extractCachedTools` 仅当 system 有缓存才提取 tools | tools 自身带 `cache_control` 也提取（独立缓存断点） |

---

## 6. 已知边界（本次不处理）

- **`estimateTokens` 仍为近似估算**：CJK 权重为经验值，非精确 tokenizer；面板标注「约 X tok」。
- **`server/context-rebuilder.ts`（489 行）整模块零 import**：属 context 模块死代码，**超出 kv-cache 审查范围，本次仅记录不删**。后续可单独评审清理（含 `calculateContextWindow` / `globalContextRebuilder` / `buildConversationSummary`）。

---

## 7. 测试覆盖

| 文件 | 覆盖点 |
|------|--------|
| [`tests/kvcache.test.ts`](tests/kvcache.test.ts) | `extractCachedContent` 全分支（explicit/auto/none、status 四态、命中率口径、CJK 估算、tools 独立缓存）、`getContextSizeForModel` |
| [`tests/log-reader.test.ts`](tests/log-reader.test.ts) | `contextWindow.totalTokens` 含 cache（与 KV-Cache 口径一致） |
| [`tests/log-manager.test.ts`](tests/log-manager.test.ts) | `convertToMarkdown` 导出真实 token 值（snake，非 undefined） |

---

## 8. 验收清单

| 编号 | 验收项 | 状态 | 验证方式 |
|------|--------|------|----------|
| AC-1 | 导出 Markdown 的 Input/Output/Cache 字段为真实数值，无 `undefined` | ✅ | `tests/log-manager.test.ts` |
| AC-2 | `contextWindow.totalTokens` 含 cache_creation + cache_read | ✅ | `tests/log-reader.test.ts` |
| AC-3 | `buildContextWindowEvent` / `parseModelBaseName` 全项目零引用 | ✅ | grep + tsc |
| AC-4 | InlineTokenStats 阈值与 KVCacheTab 同源（常量） | ✅ | tsc + 代码审查 |
| AC-5 | `LogEntry.tokenUsage` 与 RawLogEntry / 前端类型 / 数据流一致（snake） | ✅ | tsc 全量通过 |
| AC-6 | `estimateTokens` 对中文估算 > `length/4` | ✅ | `tests/kvcache.test.ts` |
| AC-7 | tools 自身带 `cache_control` 时被提取（无需 system 缓存） | ✅ | `tests/kvcache.test.ts` |
| AC-8 | 全量 `tsc --noEmit` 通过 | ✅ | `npm run build:check` 的 tsc 段 |
| AC-9 | 全量 `eslint .` 通过 | ✅ | `npm run lint` |
| AC-10 | 相关单元测试全绿 | ✅ | 5 文件 55 passed |

### 8.2 测试轮次记录

| 轮次 | 改动 | RED 断言 | 结果 |
|------|------|----------|------|
| P2-6 | `estimateTokens` CJK 权重 | `tokens > length/4`（中文） | 7→18，GREEN |
| P2-7 | `extractCachedTools` 独立断点 | `tools.length === 1`（仅 tools 带标记） | 0→1，GREEN |
| P0-2 | contextWindow 复用 totalInputTokens | `totalTokens === 650`（含 cache） | 150→650，GREEN |
| P0-1 | 类型/导出统一 snake | 导出含 `Input: 1200` 非 `undefined` | undefined→1200，GREEN |
