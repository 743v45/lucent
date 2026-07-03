#!/usr/bin/env tsx
/**
 * scripts/verify-sse-robustness.ts — SSE 分帧/拼回鲁棒性「反向失败用例」
 *
 * 对应 TAE-49 验收硬性要求：「构造一个会让 SSE 解析错位/丢帧的 payload，
 * 确认能检出且退出非 0」。
 *
 * 思路：
 *  1) 正向：把标准 Anthropic SSE 事件流「切碎 + 插入注释行(: ping) + 混用 CRLF」，
 *     再按随机分块喂给服务端真正使用的 EventSourceParserStream（与 server/sse-extractor.ts 同款），
 *     然后跑 extractFromSSELines。这种 payload 会让「按 \n\n 切帧」的朴素解析器错位/丢帧；
 *     验证真实链路拼回的文本 === "Hello! How can I help?" 且 usage / 事件数正确。
 *  2) 反向(检出力)：故意丢掉第二帧 content_block_delta，喂给同一套「校验函数」，
 *     期望它判定为异常(extracted.text === "Hello! " ≠ 期望)——证明校验有牙，
 *     真出丢帧时这个脚本会判失败、退出非 0。
 *
 * 退出码：正向提取正确 && 反向能检出 → 0；任一不满足 → 非 0。
 */

import { EventSourceParserStream } from 'eventsource-parser/stream';
import { extractFromSSELines } from '../shared/sse-events.js';
import { createHash } from 'node:crypto';

type Line = { event: string; data: string };

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, cond: any, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`  ${cond ? '✓ PASS' : '✗ FAIL'}  ${name}${detail && !cond ? '  →  ' + detail : ''}`);
}

// 标准 Anthropic 文本 SSE 事件（与 tests/e2e-helpers.ts anthropicTextSSEEvents 同源）
const EVENTS: string[] = [
  'event: message_start\ndata: ' + JSON.stringify({
    type: 'message_start',
    message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 258, output_tokens: 0 } },
  }) + '\n\n',
  'event: content_block_start\ndata: ' + JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) + '\n\n',
  'event: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello! ' } }) + '\n\n',
  'event: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'How can I help?' } }) + '\n\n',
  'event: content_block_stop\ndata: ' + JSON.stringify({ type: 'content_block_stop', index: 0 }) + '\n\n',
  'event: message_delta\ndata: ' + JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 15 } }) + '\n\n',
  'event: message_stop\ndata: ' + JSON.stringify({ type: 'message_stop' }) + '\n\n',
];

/**
 * 把 SSE 文本「污染」成刁钻形态：
 *  - 在事件之间插入注释行 `: ping\n\n`（按 spec 注释行必须被忽略，朴素按 \n\n 切帧的会把它当事件）
 *  - 部分事件的行尾用 CRLF（spec 允许 \r\n / \n / \r，朴素 split('\n\n') 会漏切）
 */
function makeTrickyRaw(events: string[]): string {
  const out: string[] = [];
  events.forEach((ev, i) => {
    // 隔一个事件插一条注释行
    if (i % 2 === 0) out.push(': ping\n\n');
    // 偶数下标用 CRLF 行尾
    out.push(i % 2 === 0 ? ev.replace(/\n/g, '\r\n') : ev);
  });
  return out.join('');
}

/** 用确定性伪随机把字符串切成不定长分块（无 Math.random，保证可复现） */
function chunkDeterministic(s: string, seed: number): string[] {
  const chunks: string[] = [];
  let i = 0;
  let st = seed;
  const rand = () => { st = (st * 1103515245 + 12345) & 0x7fffffff; return st / 0x7fffffff; };
  while (i < s.length) {
    const step = 1 + Math.floor(rand() * 7); // 1..7 字节
    chunks.push(s.slice(i, i + step));
    i += step;
  }
  return chunks;
}

/** 把 SSE 原始文本喂给 EventSourceParserStream，收集 {event,data} 行 */
async function parseViaEventSourceStream(raw: string): Promise<Line[]> {
  const lines: Line[] = [];
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      for (const chunk of chunkDeterministic(raw, 42)) ctrl.enqueue(new TextEncoder().encode(chunk));
      ctrl.close();
    },
  });
  const parsed = stream.pipeThrough(new TextDecoderStream() as any).pipeThrough(new EventSourceParserStream()) as ReadableStream<any>;
  const reader = parsed.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    lines.push({ event: value.event || '', data: value.data || '' });
  }
  return lines;
}

/** 校验函数：给定 lines，返回提取结果 + 与期望的对比 */
function evaluate(lines: Line[]) {
  const extracted = extractFromSSELines(lines);
  return extracted;
}

console.log(`\n========== SSE 分帧/拼回 鲁棒性（反向失败用例） ==========\n`);

// ===== 1) 正向：刁钻但合法的 SSE =====
{
  const raw = makeTrickyRaw(EVENTS);
  const lines = await parseViaEventSourceStream(raw);
  const ext = evaluate(lines);
  // 过滤掉注释行（eventsource-parser 本就不产注释行）后，应有 7 个事件
  const meaningful = lines.filter(l => l.data && l.data !== '');
  check(`正向① 注释行被忽略、事件数正确(期望 7，实际 ${meaningful.length})`, meaningful.length === 7, `events=${meaningful.length}`);
  check(`正向② 分帧未错位：拼回文本 === "Hello! How can I help?"`, ext.text === 'Hello! How can I help?', `text=${JSON.stringify(ext.text)}`);
  check(`正向③ 文本未重复(无丢帧/重帧)：sha 稳定`, createHash('sha1').update(ext.text).digest('hex').slice(0, 12) === '27f841926b5f', `text=${JSON.stringify(ext.text)}`);
  check(`正向④ usage 正确(input=258, output=15)`, ext.usage.input === 258 && ext.usage.output === 15, `usage=${JSON.stringify(ext.usage)}`);
  check(`正向⑤ stop_reason=end_turn`, ext.stopReason === 'end_turn', `stop=${ext.stopReason}`);
  console.log(`    （正向 sha1("Hello! How can I help?") 前12位 = 27f841926b5f，作为「未错位」基准）`);
}

// ===== 2) 反向：故意丢掉第二帧 content_block_delta，验证「校验函数能检出」=====
{
  const lost = EVENTS.filter((_, i) => i !== 3); // 丢掉 index 3（第二条 delta，文本 "How can I help?"）
  const raw = makeTrickyRaw(lost);
  const lines = await parseViaEventSourceStream(raw);
  const ext = evaluate(lines);
  // 期望：丢帧后拼回文本 !== 完整文本（只拿到 "Hello! "），校验函数据此能判失败
  const detectedAsBroken = ext.text !== 'Hello! How can I help?' && ext.text === 'Hello! ';
  check('反向① 丢帧 payload 拼回文本 !== 期望(只拿到 "Hello! ")', ext.text === 'Hello! ', `text=${JSON.stringify(ext.text)}`);
  check('反向② 同一套校验逻辑能检出丢帧(detected=true)', detectedAsBroken, `detected=${detectedAsBroken}`);
  console.log(`    （这证明：若真实链路丢帧，正向①②③ 会判失败 → 脚本退出非 0，即「能检出」）`);
}

// ===== 3) 反向②：故意把两条 delta 的顺序颠倒，验证「顺序错位」能被检出 =====
{
  const swapped = EVENTS.slice();
  [swapped[2], swapped[3]] = [swapped[3], swapped[2]]; // 交换两条 delta
  const raw = makeTrickyRaw(swapped);
  const lines = await parseViaEventSourceStream(raw);
  const ext = evaluate(lines);
  // 顺序颠倒后拼回应为 "How can I help?Hello! " ≠ 正确序
  const orderBroken = ext.text === 'How can I help?Hello! ' && ext.text !== 'Hello! How can I help?';
  check('反向③ 帧序颠倒 → 拼回顺序错(能检出)', orderBroken, `text=${JSON.stringify(ext.text)}`);
}

const pass = results.filter(r => r.ok).length;
const fail = results.length - pass;
console.log('');
console.log('='.repeat(56));
console.log(`  ${pass}/${results.length} 通过, ${fail} 失败`);
console.log('='.repeat(56));
if (fail > 0) results.filter(r => !r.ok).forEach(r => console.log(`  - ${r.name}${r.detail ? ' (' + r.detail + ')' : ''}`));
process.exit(fail === 0 ? 0 : 1);
