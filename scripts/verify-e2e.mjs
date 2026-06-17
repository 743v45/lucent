#!/usr/bin/env node
/**
 * scripts/verify-e2e.mjs — Lucent 端到端验收脚本
 *
 * 对应 openspec/specs/e2e-verification/spec.md
 *
 * 用法: npm run verify:e2e   或   node scripts/verify-e2e.mjs
 *
 * 行为:
 *   1. 启动 mock 上游（记录收到的 url/method/body）
 *   2. spawn 真后端进程（npx tsx server/index.ts）
 *   3. 发真实 HTTP 请求穿越 proxy → mock 上游
 *   4. 断言上游收到什么、proxy 返回什么
 *   5. 退出码 0 = 全绿; 非 0 = 失败
 *
 * 隔离: 用临时 config dir + 随机端口, 不碰 ~/.lucent/config.json
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// ==================== 隔离环境 ====================

const CONFIG_DIR = mkdtempSync(join(tmpdir(), 'lucent-verify-'));
const UPSTREAM_PORT = 41000 + Math.floor(Math.random() * 4000);
const PROXY_PORT = UPSTREAM_PORT + 1;
const WEB_PORT = PROXY_PORT + 2;
const UPSTREAM_BASE = `http://127.0.0.1:${UPSTREAM_PORT}/v1`;

// ==================== mock 上游 ====================

const upstreamHits = [];
const upstream = createServer((req, res) => {
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    upstreamHits.push({ url: req.url, method: req.method, body });
    // 返回一个最小合法的 Anthropic JSON 响应（proxy 非 SSE 也能处理）
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_verify', type: 'message', role: 'assistant',
      model: 'claude-verify', content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
  });
});

await new Promise(r => upstream.listen(UPSTREAM_PORT, '127.0.0.1', r));

// ==================== 配置: 预设 + 自定义供应商 ====================

writeFileSync(join(CONFIG_DIR, 'config.json'), JSON.stringify({
  host: '127.0.0.1',
  proxyPort: PROXY_PORT,
  webPort: WEB_PORT,
  providers: [
    {
      id: 'p-anthropic', name: 'anthropic',
      endpoints: {
        'anthropic-messages': UPSTREAM_BASE,
        'openai-chat': null, 'openai-responses': null,
      },
    },
    {
      id: 'p-openai', name: 'openai',
      endpoints: {
        'anthropic-messages': null,
        'openai-chat': UPSTREAM_BASE,
        'openai-responses': UPSTREAM_BASE,
      },
    },
    {
      id: 'p-foo', name: 'foo',  // 自定义供应商示例
      endpoints: {
        'anthropic-messages': UPSTREAM_BASE,
        'openai-chat': null, 'openai-responses': null,
      },
    },
    {
      id: 'p-noservice', name: 'noservice',  // 所有 endpoint 都 null
      endpoints: {
        'anthropic-messages': null,
        'openai-chat': null, 'openai-responses': null,
      },
    },
  ],
}));

// ==================== 启动后端 ====================

const backend = spawn('npx', ['tsx', 'server/index.ts'], {
  cwd: REPO_ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    LUCENT_CONFIG_DIR: CONFIG_DIR,
    LUCENT_HOST: '127.0.0.1',
    LUCENT_PROXY_PORT: String(PROXY_PORT),
    LUCENT_WEB_PORT: String(WEB_PORT),
    LUCENT_LOG_DIR: join(CONFIG_DIR, 'logs'),
  },
});

// ==================== 工具: 断言 + 报告 ====================

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  const tag = cond ? '✓ PASS' : '✗ FAIL';
  console.log(`  ${tag}  ${name}${detail && !cond ? '  →  ' + detail : ''}`);
}

async function post(url, headers, body) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    let resBody = '';
    try { resBody = await res.text(); } catch {}
    return { status: res.status, body: resBody };
  } catch (e) {
    return { status: 0, body: String(e) };
  }
}

function lastUpstream() {
  return upstreamHits[upstreamHits.length - 1];
}

// ==================== 等待后端就绪 ====================

await new Promise((resolve, reject) => {
  const to = setTimeout(() => reject(new Error('startup timeout')), 25000);
  let resolved = false;
  backend.stdout.on('data', d => {
    if (!resolved && /Lucent|代理|listen|启动|started|ready/i.test(d.toString())) {
      resolved = true; clearTimeout(to); resolve();
    }
  });
  backend.stderr.on('data', () => {});  // 静默, 失败时看 exit
  backend.on('exit', c => { if (!resolved) reject(new Error(`backend exit ${c}`)); });
});
await new Promise(r => setTimeout(r, 800));  // 额外缓冲

console.log(`\n========== Lucent 端到端验收 ==========\n`);
console.log(`  上游 mock: http://127.0.0.1:${UPSTREAM_PORT}/v1`);
console.log(`  后端:     proxy=${PROXY_PORT} web=${WEB_PORT}`);
console.log(`  config:   ${CONFIG_DIR}\n`);

const PROXY = `http://127.0.0.1:${PROXY_PORT}`;
const WEB = `http://127.0.0.1:${WEB_PORT}`;

const ANTH_HEADERS = { 'x-api-key': 'sk-x', 'anthropic-version': '2023-06-01' };
const OAI_HEADERS = { authorization: 'Bearer sk-x' };
const ANTH_REQ = { model: 'claude-x', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] };
const OAI_CHAT_REQ = { model: 'gpt-4o', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] };
const OAI_RESP_REQ = { model: 'gpt-4o', input: 'hi' };

// 用于场景 10 的一致性比对
const forwardedPaths = {};
const testedPaths = {};

try {

  // ---- 场景 1: 预设 anthropic 代理转发 ----
  upstreamHits.length = 0;
  await post(`${PROXY}/anthropic/v1/messages`, ANTH_HEADERS, ANTH_REQ);
  check('1. 预设 anthropic 代理转发 → 上游收到 /v1/messages',
    lastUpstream()?.url === '/v1/messages' && !lastUpstream()?.url.includes('/v1/v1'),
    `上游收到: ${lastUpstream()?.url}`);
  forwardedPaths['anthropic-messages'] = lastUpstream()?.url;

  // ---- 场景 2: 预设 openai chat 代理转发 ----
  upstreamHits.length = 0;
  await post(`${PROXY}/openai/v1/chat/completions`, OAI_HEADERS, OAI_CHAT_REQ);
  check('2. 预设 openai-chat 代理转发 → 上游收到 /v1/chat/completions',
    lastUpstream()?.url === '/v1/chat/completions' && !lastUpstream()?.url.includes('/v1/v1'),
    `上游收到: ${lastUpstream()?.url}`);
  forwardedPaths['openai-chat'] = lastUpstream()?.url;

  // ---- 场景 3: 预设 openai responses 代理转发 ----
  upstreamHits.length = 0;
  await post(`${PROXY}/openai/v1/responses`, OAI_HEADERS, OAI_RESP_REQ);
  check('3. 预设 openai-responses 代理转发 → 上游收到 /v1/responses',
    lastUpstream()?.url === '/v1/responses' && !lastUpstream()?.url.includes('/v1/v1'),
    `上游收到: ${lastUpstream()?.url}`);
  forwardedPaths['openai-responses'] = lastUpstream()?.url;

  // ---- 场景 4: 自定义供应商带 /v1 ----
  upstreamHits.length = 0;
  await post(`${PROXY}/custom/foo/v1/messages`, ANTH_HEADERS, ANTH_REQ);
  const fooWithV1 = lastUpstream()?.url;
  check('4. 自定义 /custom/foo/v1/messages → 上游收到 /v1/messages',
    fooWithV1 === '/v1/messages' && !fooWithV1.includes('/v1/v1'),
    `上游收到: ${fooWithV1}`);

  // ---- 场景 5: 自定义供应商不带 /v1 ----
  upstreamHits.length = 0;
  await post(`${PROXY}/custom/foo/messages`, ANTH_HEADERS, ANTH_REQ);
  const fooNoV1 = lastUpstream()?.url;
  check('5. 自定义 /custom/foo/messages → 上游收到 /v1/messages(与带 /v1 一致)',
    fooNoV1 === '/v1/messages' && fooNoV1 === fooWithV1,
    `上游收到: ${fooNoV1}`);

  // ---- 场景 6: 测试连接 anthropic-messages ----
  upstreamHits.length = 0;
  await post(`${WEB}/api/providers/foo/test`, {}, { endpointType: 'anthropic-messages' });
  check('6. 测试连接 anthropic-messages → 上游收到 /v1/messages(无双 v1)',
    lastUpstream()?.url === '/v1/messages' && !lastUpstream()?.url.includes('/v1/v1'),
    `上游收到: ${lastUpstream()?.url}`);
  testedPaths['anthropic-messages'] = lastUpstream()?.url;

  // ---- 场景 7: 测试连接 openai-chat ----
  upstreamHits.length = 0;
  await post(`${WEB}/api/providers/openai/test`, {}, { endpointType: 'openai-chat' });
  check('7. 测试连接 openai-chat → 上游收到 /v1/chat/completions(无双 v1)',
    lastUpstream()?.url === '/v1/chat/completions' && !lastUpstream()?.url.includes('/v1/v1'),
    `上游收到: ${lastUpstream()?.url}`);
  testedPaths['openai-chat'] = lastUpstream()?.url;

  // ---- 场景 8: 测试连接 openai-responses ----
  upstreamHits.length = 0;
  await post(`${WEB}/api/providers/openai/test`, {}, { endpointType: 'openai-responses' });
  check('8. 测试连接 openai-responses → 上游收到 /v1/responses(无双 v1)',
    lastUpstream()?.url === '/v1/responses' && !lastUpstream()?.url.includes('/v1/v1'),
    `上游收到: ${lastUpstream()?.url}`);
  testedPaths['openai-responses'] = lastUpstream()?.url;

  // ---- 场景 9: 404 行为 ----
  const unknown = await post(`${PROXY}/nonexistent/v1/messages`, ANTH_HEADERS, ANTH_REQ);
  check('9a. 不存在的供应商 → 404',
    unknown.status === 404, `状态: ${unknown.status}`);

  const noservice = await post(`${PROXY}/noservice/v1/messages`, ANTH_HEADERS, ANTH_REQ);
  check('9b. 端点全 null 的供应商 → 404',
    noservice.status === 404, `状态: ${noservice.status}`);

  const wrongEndpoint = await post(`${PROXY}/anthropic/v1/chat/completions`, OAI_HEADERS, OAI_CHAT_REQ);
  check('9c. anthropic(只配了 anthropic-messages) 收 openai-chat 请求 → 404',
    wrongEndpoint.status === 404, `状态: ${wrongEndpoint.status}`);

  // ---- 场景 10: 测试连接 vs 代理转发路径一致性 ----
  console.log('');
  let consistent = true;
  for (const k of ['anthropic-messages', 'openai-chat', 'openai-responses']) {
    if (forwardedPaths[k] !== testedPaths[k]) {
      consistent = false;
      check(`10. ${k}: 测试连接路径 == 代理转发路径`, false,
        `代理转发=${forwardedPaths[k]} 测试连接=${testedPaths[k]}`);
    }
  }
  if (consistent) {
    check('10. 三种 endpoint 测试连接路径 == 代理转发路径(完全一致)', true);
  }

} finally {
  backend.kill('SIGTERM');
  upstream.close();
  await new Promise(r => setTimeout(r, 300));
  try { rmSync(CONFIG_DIR, { recursive: true, force: true }); } catch {}
}

// ==================== 汇总 ====================

const pass = results.filter(r => r.ok).length;
const fail = results.length - pass;
console.log('');
console.log('='.repeat(48));
console.log(`  ${pass}/${results.length} 通过, ${fail} 失败`);
console.log('='.repeat(48));

if (fail > 0) {
  console.log('\n失败项:');
  results.filter(r => !r.ok).forEach(r => console.log(`  - ${r.name}${r.detail ? ' (' + r.detail + ')' : ''}`));
}

process.exit(fail === 0 ? 0 : 1);
