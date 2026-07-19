# 定时自动刷新日志 — 设计文档

- 日期：2026-07-19
- 状态：待实现
- 范围：纯前端，无后端 / API / 协议改动
- 对应需求：顶栏可设置自动刷新间隔（`关闭 / 5s / 10s / 1min / 10min / 1h`，默认关闭），前端记忆设置

---

## 1. 背景与目标

当前日志列表靠手动点顶栏 [refresh-btn](../../src/App.tsx#L263) 刷新（调用 [useLogs.loadLogs](../../src/hooks/useLogs.ts#L80)：拉首页 + 重置游标 + 替换列表）。实时推送端点 `/api/logs/stream` 目前是骨架、未接通（见 [server/routes/logs.ts:29](../../server/routes/logs.ts#L29) 的 TODO），前端只能手动刷新。

在 SSE 接通前，提供一个**轮询式定时刷新**作为务实过渡：用户设定间隔后，列表按间隔自动拉取最新日志，无需手动点。

## 2. 范围（YAGNI）

**做**：
- 顶栏新增间隔选择器；按间隔自动调用现有 `loadLogs`。
- 设置记忆到 localStorage。

**不做**（避免投机）：
- 不接通 SSE / WebSocket（那是独立的大改，见 `server/routes/logs.ts:29` TODO）。
- 不做"增量追加、保持滚动位置"——定时刷新语义就是"回到最新首页"（复用 `loadLogs` 固有行为）。
- 不改手动刷新按钮、不改后端。

## 3. 交互设计

顶栏 [refresh-btn](../../src/App.tsx#L263) **右侧**新增一个 antd 小尺寸 `Select`（`size="small"`，贴合现有 `px-2 py-1.5` / 13px 紧凑顶栏风格；遵守 [UI 规则](../../src/App.tsx)：Tailwind 工具类、禁手写 CSS）。

选项（顺序，"关闭"居首因为它是默认态）：

| 值（id）   | 显示 | 毫秒     |
| ---------- | ---- | -------- |
| `off`      | 关闭 | —        |
| `5s`       | 5秒  | 5,000    |
| `10s`      | 10秒 | 10,000   |
| `1min`     | 1分钟| 60,000   |
| `10min`    | 10分钟| 600,000 |
| `1h`       | 1小时| 3,600,000 |

- 默认 `off`，不轮询。
- 选中非 `off`：按对应毫秒 `setInterval`，每 tick 调 `loadLogs`。
- 切换间隔 / 选回 `off`：立即生效（清旧 timer）。
- `data-testid="refresh-interval-select"`（e2e 稳定契约，沿用项目 testid 约定，见 [e2e/seed.spec.ts](../../e2e/seed.spec.ts)）。

## 4. 行为规格（SHALL）

1. **默认关闭**：初始化时 interval = `off`（localStorage 无值时），SHALL NOT 启动任何定时器。
2. **定时触发**：interval ≠ `off` 时 SHALL 按 `REFRESH_INTERVAL_MS[interval]` 启动 `setInterval`，每 tick 调 `onRefresh`。
3. **切换立即生效**：`setRefreshInterval(newVal)` SHALL 先清旧 timer，再按新值建 timer（`off` 则不建）。
4. **防重叠**：tick 触发时若 `skipIf()` 返回 true（默认接 `() => logsLoading`），SHALL 跳过本轮，不发并发请求。
5. **省流（页面不可见暂停）**：`pauseWhenHidden`（默认 true）时，`document.hidden === true` SHALL 暂停（clear）；`visibilitychange` 回到可见 SHALL 立即触发一次 `onRefresh` 再恢复定时。
6. **持久化**：`setInterval(v)` SHALL 写 localStorage（key = `STORAGE_KEY_REFRESH_INTERVAL`）；初始化 SHALL 从 localStorage 读，无值用默认 `off`。非法值 SHALL 回退 `off`。
7. **卸载清理**：组件卸载 SHALL 清 timer，不泄漏。
8. **手动刷新不受影响**：[refresh-btn](../../src/App.tsx#L263) 行为不变。

## 5. 实现拆解

### 5.1 常量（`src/constants.ts`，与 [STORAGE_KEY_SIDEBAR_WIDTH](../../src/App.tsx#L41) 同套）

```ts
export const STORAGE_KEY_REFRESH_INTERVAL = 'lucent.refreshInterval';

export type RefreshIntervalId = 'off' | '5s' | '10s' | '1min' | '10min' | '1h';

export const REFRESH_INTERVAL_OPTIONS: { value: RefreshIntervalId; label: string }[] = [
  { value: 'off', label: '关闭' },
  { value: '5s', label: '5秒' },
  { value: '10s', label: '10秒' },
  { value: '1min', label: '1分钟' },
  { value: '10min', label: '10分钟' },
  { value: '1h', label: '1小时' },
];

export const REFRESH_INTERVAL_MS: Record<RefreshIntervalId, number | null> = {
  off: null, '5s': 5_000, '10s': 10_000, '1min': 60_000, '10min': 600_000, '1h': 3_600_000,
};

/** 从 localStorage 原始值解析 interval：非法/空用 defaultValue（默认 'off'）。纯函数，node 可单测。 */
export function parseRefreshInterval(
  raw: string | null,
  defaultValue: RefreshIntervalId = 'off',
): RefreshIntervalId {
  const valid: RefreshIntervalId[] = ['off', '5s', '10s', '1min', '10min', '1h'];
  return raw && (valid as string[]).includes(raw) ? (raw as RefreshIntervalId) : defaultValue;
}
```

### 5.2 新 hook：`src/hooks/useAutoRefresh.ts`

单一职责：interval 状态 + localStorage 持久化 + `setInterval` 生命周期 + hidden 暂停 + skip 守卫。独立成 hook 便于 vitest 用 fake timers 单测。

```ts
interface UseAutoRefreshOptions {
  onRefresh: () => void | Promise<void>;
  skipIf?: () => boolean;            // 默认 () => false
  pauseWhenHidden?: boolean;         // 默认 true
  storageKey: string;
  defaultValue?: RefreshIntervalId;  // 默认 'off'
}
interface UseAutoRefreshResult {
  interval: RefreshIntervalId;
  setRefreshInterval: (v: RefreshIntervalId) => void;  // 设值 + 持久化 + 重建 timer
}
export function useAutoRefresh(opts: UseAutoRefreshOptions): UseAutoRefreshResult;
```

内部用 `useRef` 持有 timer id；`useEffect` 依赖 `[interval]` 重建 timer 并在 cleanup 清理；`visibilitychange` 监听在 interval≠off 且 pauseWhenHidden 时挂载。

### 5.3 `src/App.tsx` 接线

- 在 [refresh-btn](../../src/App.tsx#L263) 后插入 `<Select size="small" data-testid="refresh-interval-select" ...>`，options = `REFRESH_INTERVAL_OPTIONS`。
- 调用 hook：
  ```ts
  const { interval: refreshInterval, setRefreshInterval } = useAutoRefresh({
    onRefresh: loadLogs,
    skipIf: () => logsLoading,
    storageKey: STORAGE_KEY_REFRESH_INTERVAL,
  });
  ```

## 6. 文件改动清单

| 操作 | 文件 | 说明 |
| ---- | ---- | ---- |
| 改 | `src/constants.ts` | 加 `STORAGE_KEY_REFRESH_INTERVAL` + `RefreshIntervalId` + `REFRESH_INTERVAL_OPTIONS` + `REFRESH_INTERVAL_MS` |
| 新增 | `src/hooks/useAutoRefresh.ts` | 定时刷新 hook |
| 改 | `src/App.tsx` | 顶栏加 `<Select>` + 接线 hook |
| 新增 | `tests/auto-refresh.test.ts` | vitest(node) 单测纯函数 `parseRefreshInterval` |
| 新增 | `e2e/auto-refresh.spec.ts` | Playwright UI 交互 spec |

## 7. OpenSpec 取舍

本功能纯前端、不引入新核心行为契约（协议 / 路由 / 记录行为均不变），按项目 [CLAUDE.md](../../CLAUDE.md)「琐碎功能不 archive，仅留记录」处理：**不走 OpenSpec change archive**，仅本 design doc 留记录。如审查认为应正式立项，再补 `openspec/changes/2026-07-19-auto-refresh/proposal.md`。

## 8. 验收标准

> 测试基础设施约束：本项目 vitest 为 `environment: 'node'`（见 [vitest.config.ts](../../vitest.config.ts)），无 jsdom / `@testing-library`，**React hook 不可单测**，且项目所有 React UI 行为均靠 Playwright e2e 验。故 timer 生命周期、hidden 暂停等 DOM 相关行为用 e2e 覆盖；仅 localStorage 解析这一**纯函数**用 node 单测。

| #  | 验收项 | 测试手段 |
| -- | ------ | -------- |
| 1  | 默认 `off`，Select 显示"关闭"，不自动刷新 | e2e |
| 2  | 选 `5s` 后端到端：发新请求不手动刷新，~6s 后列表自动出现新 log-row | e2e |
| 3  | 切回 `off` 停止自动刷新 | e2e |
| 4  | 刷新页面后间隔设置保留（localStorage 记忆） | e2e（reload 后 Select 值不变） |
| 5  | 手动 [refresh-btn](../../src/App.tsx#L263) 不受影响 | e2e |
| 6  | localStorage 非法值回退 `off`；null/空用默认 | 纯函数单测 `parseRefreshInterval` |
| 7  | tab 后台暂停、回前台立即刷一次再恢复 | 代码实现 + 手动验证（e2e 模拟 visibility 复杂，不强求自动化） |

### 8.2 测试轮次记录

| 轮次 | 命令 | 结果 | 备注 |
| ---- | ---- | ---- | ---- |
| 1 | `npx tsc --noEmit` | 通过 | 全项目类型检查 |
| 2 | `npx vitest run tests/auto-refresh.test.ts` | 4 passed | `parseRefreshInterval` 纯函数单测 |
| 3 | `npm run test:run` | 504 passed (28 files) | 全量单测无回归 |
| 4 | `npx playwright test e2e/auto-refresh.spec.ts` | 4 passed | auto-refresh e2e |
| 5 | `npm run e2e:ui` | 43 passed (1.8m) | 全量 UI e2e 无回归 |

## 9. 风险与权衡

- **刷新重置游标**：定时触发会丢弃"加载更多"翻到的历史页（见 [loadLogs](../../src/hooks/useLogs.ts#L80)）。已在 §2 明确为可接受语义。
- **e2e 慢用例**：验收 11 需等真实 5s+。单测（验收 2/3/4/6/7/9/10）用 fake timers 覆盖 timer 逻辑，e2e 只验端到端接线，慢用例仅 1 个。
- **共享后端污染**：e2e fixture 是 worker-scoped 共享后端（见 [e2e/fixtures.ts](../../e2e/fixtures.ts)），spec 起手 SHALL `lucent.clearLogs()` 避免历史日志干扰断言。
- **测试环境约束**：vitest 为 node 环境（[vitest.config.ts](../../vitest.config.ts)），不测 React hook；useAutoRefresh 的 timer/hidden 行为靠 e2e 黑盒覆盖，仅 `parseRefreshInterval` 纯函数单测。
- **antd v6 Select 虚拟滚动**：v6 默认 `rc-virtual-list`，仅 6 项也只渲染前 2 个且 option 定位异常（e2e 点击报 outside viewport）。Select 设 `virtual={false}` 关闭，全量渲染可点；选项少无性能影响。e2e 经 `.ant-select-content`（v6 选中值文本节点，非旧 `.ant-select-selection-item`）读当前值。
