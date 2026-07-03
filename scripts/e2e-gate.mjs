#!/usr/bin/env node
/**
 * scripts/e2e-gate.mjs —— 统一端到端验收 gate
 *
 * 串三段，任一失败立即停并非 0 退出（后续阶段跳过）：
 *   1. verify:e2e  — 路由 / URL 拼接层（后端协议链路）
 *   2. test:run    — vitest 全量单测 / e2e（tests 目录）
 *   3. e2e:ui      — Playwright Web UI 交互层 specs（e2e 目录）
 *
 * 用法：npm run e2e
 *
 * 三段覆盖的层次互补：verify:e2e 验后端路由、test:run 验单元/后端 e2e、e2e:ui 验
 * 浏览器里真实可点击的交互。前两层是既有资产，第三层是本 issue 新增的地基。
 */
import { spawn } from 'node:child_process';

const STAGES = [
  { name: 'verify:e2e', cmd: 'npm', args: ['run', 'verify:e2e'], label: '后端协议链路验收 (npm run verify:e2e)' },
  { name: 'test:run', cmd: 'npm', args: ['run', 'test:run'], label: 'vitest 全量单测/e2e (npm run test:run)' },
  { name: 'e2e:ui', cmd: 'npx', args: ['playwright', 'test'], label: 'Web UI 交互层 specs (npx playwright test)' },
];

function runStage(stage) {
  return new Promise((resolve) => {
    console.log(`\n${'='.repeat(72)}`);
    console.log(`▶ ${stage.label}`);
    console.log('='.repeat(72));
    // win32 上 npm/npx 是 .cmd，需要 shell；Unix 上直接 execvp 走 PATH
    const proc = spawn(stage.cmd, stage.args, { stdio: 'inherit', shell: process.platform === 'win32' });
    proc.on('exit', (code) => resolve(code ?? 1));
    proc.on('error', (err) => {
      console.error(`阶段 ${stage.name} 启动失败: ${err.message}`);
      resolve(1);
    });
  });
}

let failed = null;
for (const stage of STAGES) {
  const code = await runStage(stage);
  if (code !== 0) { failed = { name: stage.name, code }; break; }
}

console.log(`\n${'='.repeat(72)}`);
if (failed) {
  console.log(`✗ e2e gate 失败：阶段「${failed.name}」退出码 ${failed.code}（后续阶段已跳过）`);
} else {
  console.log('✓ e2e gate 全绿：verify:e2e + test:run + e2e:ui 三段通过');
}
console.log('='.repeat(72));
process.exit(failed ? failed.code : 0);
