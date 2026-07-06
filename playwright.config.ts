import { defineConfig } from '@playwright/test';

/**
 * Playwright 配置 —— Lucent Web UI 交互层 e2e
 *
 * 每个 spec 自带隔离栈（见 e2e/fixtures.ts：mock 上游 + 临时 config + 随机端口
 * + 起 backend + vite dev），所以这里不配 webServer——栈的生命周期跟 spec 走，
 * 互不抢端口。单 worker：栈串行起停，避免并发抢端口。
 *
 * 与 scripts/verify-*-e2e.ts 的关系：那些是一次性验收脚本（一个脚本跑完一堆
 * 断言就退出）；这里是 spec 化的交互测试（点、切、滚），是 F1–F6 交互 spec 的
 * 容器。共用 tests/e2e-helpers.ts 的 mock 上游范式，不重造。
 */
export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  fullyParallel: false,
  // 单 worker：fixture 起的是真实 backend + vite，多 worker 会抢端口 + 拖慢
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  use: {
    headless: true,
    actionTimeout: 10_000,
    // 冷启动（vite 缓存冷）首次导航要触发按需编译整个源码模块图，15s 偏紧会假阳；
    // 缓存热后远低于此值。放宽到 30s 给冷编译留余量，整体仍受 test timeout 60s 兜底。
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
});
