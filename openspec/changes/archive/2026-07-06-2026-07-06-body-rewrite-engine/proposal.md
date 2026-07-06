## Why

Lucent 的核心原则是「请求 body 一个字不改」（见
[request-transformation-design §7](../../docs/superpowers/specs/2026-06-19-request-transformation-design.md#L271)、
[§11](../../docs/superpowers/specs/2026-06-19-request-transformation-design.md#L359)）——上游
不应感知代理的存在。这条原则在 99% 场景下正确，但缺一个**可选 opt-in 的出口**：

- Claude Code 等客户端会在 `system[0].text` 里注入计费/溯源头
  （`x-anthropic-billing-header: cc_version=...; cc_entrypoint=cli;`）。用户若把
  Lucent 指向**非官方中转/自建网关**，这些头会被上游直接拒绝或计入计费，目前没有
  代理层手段去除——只能改客户端，违背了「透明代理」的定位。
- 其它脱敏场景（抹掉请求里的敏感 PII、内部路径）同理。

所以需要一个 **opt-in、默认零变化、失败回退原 body** 的 body 重写规则引擎：用户显式
配置规则才生效，未配置走原路径零开销，零命中返回原 buffer 引用（字节级透明）。这是对
默认透明原则的**受控补丁**而非放弃——把破坏性的「改 body」行为收敛进一个显式、可校验、
可审计、可回退的窄口子。

## What Changes

- **类型（已落地）**：[`server/types.ts`](../../server/types.ts) 新增 `BodyRewriteRule`
  接口：`{ id, name?, enabled?, fieldPath, pattern, flags?, replacement }`。
- **配置**：`~/.lucent/config.json` 顶层新增可选字段 `bodyRewrites: BodyRewriteRule[]`，
  走 [`server/config.ts`](../../server/config.ts) 的 `loadConfig`/`ProxyConfig`。配置含
  非法规则时，`validateBodyRewrites` 抛错，`loadConfig` 备份 `config.json.bak` 后覆盖
  默认 providers（继承自现有校验失败路径）。
- **引擎**：新增 [`server/body-rewriter.ts`](../../server/body-rewriter.ts)，导出
  `parseFieldPath` / `getNestedValue` / `applyBodyRewrites` /
  `applyBodyRewritesToBuffer`。
  - 语义：对 `fieldPath` 定位到的 **string 叶子值**做子串替换
    `value.replace(new RegExp(pattern, flags ?? 'g'), replacement)`，保留未匹配部分。
  - `flags` 缺省按 `'g'`（脱敏 safe-by-default：默认替换全部命中而非只替换首个）。
  - 多条规则按数组顺序**级联**：前一条的输出是后一条的输入。
  - 零命中/未配置：返回原 buffer 引用，字节级透明、零拷贝。
- **注入点**：[`server/proxy.ts`](../../server/proxy.ts) 在 body 读取后、`fetch()` 前
  调用 `applyBodyRewritesToBuffer`。三层异常保护：JSON 解析失败、规则抛错、缓冲区回写
  失败——任一异常都回退原 body，不阻断请求。
- **校验**：`validateBodyRewrites` 严格校验：禁未知键、`id` 非空、`fieldPath` 可解析、
  `RegExp` 可构造、`flags ∈ [gimsuy]*`、`pattern`/`replacement`/`fieldPath` 为 string。
- **测试**：
  - `tests/body-rewriter.test.ts`（vitest 单元测试）：覆盖 parseFieldPath、
    getNestedValue、子串替换、flags 缺省 g、顺序级联、仅 string 叶子、零命中字节透明、
    失败回退、非法配置校验。
  - `scripts/verify-body-rewrite-e2e.ts`（tsx E2E 验收）：mock 上游 + 真实代理链路，
    断言脱敏命中、零命中透明、失败回退、JSONL 日志记录重写后 body。
  - `npm run verify:body-rewrite` 入口。
- **文档**：更新
  [request-transformation-design §7](../../docs/superpowers/specs/2026-06-19-request-transformation-design.md#L271)
  （默认仍一字不改 + opt-in 引擎说明 + KV-Cache/agent 分类副作用警告）和
  [§11](../../docs/superpowers/specs/2026-06-19-request-transformation-design.md#L359)
  决策记录表加一行。

## Capabilities

### New Capabilities
- `body-rewrite`：opt-in 请求 body 重写规则引擎。契约覆盖：规则结构
  （`BodyRewriteRule` 每字段类型与约束）、`fieldPath` 语法（对象键 `a.b.c` + 数组下标
  `a[0].b` 混合）、子串替换语义
  （`value.replace(new RegExp(pattern, flags ?? 'g'), replacement)`，仅 string 叶子）、
  `flags ∈ [gimsuy]*` 缺省 `g`、多规则顺序级联、失败回退原 buffer 不阻断、零命中字节
  透明、严格配置校验（禁未知键 / fieldPath 可解析 / RegExp 可构造）。

### Modified Capabilities
无。

## Impact

- **受影响代码**：
  - [`server/types.ts`](../../server/types.ts)：`BodyRewriteRule` 接口（已落地）。
  - [`server/config.ts`](../../server/config.ts)：`ProxyConfig.bodyRewrites?` 字段 +
    `validateBodyRewrites`。
  - [`server/proxy.ts`](../../server/proxy.ts)：body 读取后、fetch 前注入重写。
- **新增文件**：
  - [`server/body-rewriter.ts`](../../server/body-rewriter.ts)：重写引擎。
  - [`tests/body-rewriter.test.ts`](../../tests/body-rewriter.test.ts)：vitest 单测。
  - [`scripts/verify-body-rewrite-e2e.ts`](../../scripts/verify-body-rewrite-e2e.ts)：E2E。
- **受影响 npm scripts**：`package.json` 新增 `verify:body-rewrite`。
- **默认零变化**：未配置 `bodyRewrites` 或数组为空时，走原路径零开销；零命中返回原
  buffer 引用（`===` 恒等，字节级透明）。现有所有单测、`verify:*` 系列 E2E 不受影响。
- **关键副作用（opt-in 固有代价，必须登记）**：
  1. 🔴 **破坏上游 KV-Cache**：重写位于缓存前缀内的字段（典型 `system[0].text` 带
     `cache_control` 断点）→ Anthropic 按字节寻址 cache miss → `cache_read` 归零、重新
     `cache_creation`。Lucent 本地不算哈希，无法在代理端规避。
  2. 🔴 **改变 agent 分类 / threadId**：interceptor 的 `classifyAgent` / `identify` 跑在
     重写后 body 上 → 激进脱敏可能误分类子 agent、切会话线索。
  3. 🟡 **config 全量重置**：配置含非法 regex → `loadConfig` 备份
     `config.json.bak` 并覆盖默认 providers（继承自现有校验失败路径，非新行为）。
  4. 🟢 **JSONL 日志记录重写后 body**（脱敏场景通常正合意图）；命中后 body 被
     `JSON.stringify` 紧凑化（空白变化）；多规则按数组顺序级联；用户自配 `pattern` 的
     ReDoS 风险自负。
- **不影响**：Web UI、REST API、响应 body 重写、协议路由、Header 变换、三协议路径解析。
