/**
 * SSE Usage 验证脚本
 *
 * 用法: npx tsx scripts/verify-sse-usage.ts /tmp/lucent-sse-debug/{file}.sse
 *
 * 对比提取结果与上游原始值，验证 SSE 解析正确性
 */

import { readFileSync } from 'node:fs';
import { extractFromSSELines } from '../server/sse-extractor.js';

const file = process.argv[2];
if (!file) {
  console.error('Usage: npx tsx scripts/verify-sse-usage.ts <sse-file>');
  process.exit(1);
}

const raw = readFileSync(file, 'utf-8');
const lines: { event: string; data: string }[] = [];
for (const chunk of raw.split('\n\n')) {
  let event = '', data = '';
  for (const line of chunk.split('\n')) {
    if (line.startsWith('event: ')) event = line.slice(7);
    else if (line.startsWith('data: ')) data = line.slice(6);
  }
  if (data) lines.push({ event, data });
}

const result = extractFromSSELines(lines);

// 找 message_delta 中的原始 usage（Anthropic 格式的最终 usage）
const deltaLine = lines.find(l => l.event === 'message_delta');
const rawUsage = deltaLine ? JSON.parse(deltaLine.data).usage : null;

console.log('=== SSE Usage 验证 ===');
console.log(`文件: ${file}`);
console.log(`事件数: ${lines.length}`);
console.log(`模型: ${result.model}`);
console.log();

const checks = [
  { name: 'input', extracted: result.usage.input, raw: rawUsage?.input_tokens ?? 0 },
  { name: 'output', extracted: result.usage.output, raw: rawUsage?.output_tokens ?? 0 },
  { name: 'cache_read', extracted: result.usage.cache_read, raw: rawUsage?.cache_read_input_tokens ?? 0 },
  { name: 'cache_create', extracted: result.usage.cache_create, raw: rawUsage?.cache_creation_input_tokens ?? 0 },
];

let allPass = true;
for (const c of checks) {
  const pass = c.extracted === c.raw;
  if (!pass) allPass = false;
  console.log(`  ${pass ? '✅' : '❌'} ${c.name}: extracted=${c.extracted} raw=${c.raw}`);
}

console.log();
console.log(allPass ? '✅ 全部通过' : '❌ 存在不一致');
process.exit(allPass ? 0 : 1);
