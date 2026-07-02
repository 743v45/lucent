#!/usr/bin/env tsx
/**
 * scripts/setup-openai-provider.ts — 启动前 seed：读 OPENAI_BASE_URL 自动配 openai provider
 *
 * 背景：Lucent 是透明代理，provider 只从 config.json 来、进程不读 OPENAI_*。
 * 这个脚本在 `npm start` 前跑一次，把全局 OPENAI_BASE_URL 合并进 config.json，
 * 让容器/部署环境零手配就能用 openai 端点 —— di4urp 要的"环境变量驱动、方便复用"。
 *
 * 用法:
 *   npm run setup:openai            （写 ~/.lucent/config.json）
 *   npm run setup:openai && npm start
 *   LUCENT_CONFIG_DIR=/tmp/x npm run setup:openai   （隔离测试，不碰本机）
 *
 * 行为:
 *   - 必需 OPENAI_BASE_URL 没设 → 报错退出（exit 2），不静默跳过。
 *   - config.json 不存在 → loadConfig 自动建默认（含 anthropic 种子），再追加 openai。
 *   - 已有 name=openai provider → 跳过、不覆盖（幂等 + 尊重手配）；要对齐地址请删后重跑。
 *   - 不碰 key：Lucent provider 只存 baseUrl，Authorization / model 由客户端请求时自带。
 *
 * baseUrl 应已含 /v1（如 http://new-api:3000/v1）—— proxy 的路径拼接假设 baseUrl 含版本路径。
 */

import { loadConfig, getConfig, findProviderByName, createProvider } from '../server/config.js';

const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL;

if (!OPENAI_BASE_URL) {
  console.error('[setup:openai] OPENAI_BASE_URL 未设，无法 seed openai provider。');
  console.error('  设成上游网关地址（如 http://new-api:3000/v1）后再跑：OPENAI_BASE_URL=... npm run setup:openai');
  process.exit(2);
}

// baseUrl 形态提示：proxy 路径拼接假设 baseUrl 含 /v1，缺了运行时会 404。只 warn 不阻断。
if (!/\/v\d+\/?$/.test(OPENAI_BASE_URL)) {
  console.warn(`[setup:openai] 警告：OPENAI_BASE_URL=${OPENAI_BASE_URL} 不含 /v1。Lucent 代理假设 baseUrl 含版本路径，缺了请求会 404——确认地址无误再继续。`);
}

// 1. 确保 config 存在（不存在 → 建默认，含 anthropic 种子 provider）
loadConfig();
const cfg = getConfig();

// 2. 已有 openai → 跳过（幂等 + 尊重现有配置），亮出现有地址方便核对
const existing = findProviderByName(cfg, 'openai');
if (existing) {
  const cur = existing.endpoints['openai-chat'];
  const match = cur === OPENAI_BASE_URL ? '（一致）' : '（不一致，要对齐请删后重跑）';
  console.log(`[setup:openai] 已有 openai provider，未覆盖（尊重现有配置）。`);
  console.log(`  现有 openai-chat → ${cur ?? '(null)'}；本次 OPENAI_BASE_URL=${OPENAI_BASE_URL} ${match}`);
  process.exit(0);
}

// 3. 没有 → 创建（name=openai 是预设保留名，须带 presetName 且等于 name）
createProvider({
  name: 'openai',
  presetName: 'openai',
  endpoints: {
    'openai-chat': OPENAI_BASE_URL,
    'openai-responses': OPENAI_BASE_URL,
    'anthropic-messages': null,
  },
});

console.log(`[setup:openai] 已创建 openai provider → ${OPENAI_BASE_URL}`);
console.log(`  客户端调用 http://<lucent>:7048/openai/v1/...，Authorization 与 model 请求时自带。`);
