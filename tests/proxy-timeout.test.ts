/**
 * 代理上游超时护栏单测（server/proxy.ts）
 *
 * 回归 Bug #6：上游无超时 / AbortController。
 *   - server/proxy.ts 原 fetch 无 signal，res.on('close') 只 destroy nodeStream，
 *     客户端在响应头到达前断开时不会取消上游 fetch，上游按 token 计费的配额被空烧；
 *     上游 stall 时主链路无限挂起。
 *
 * 修复后每次转发构造 AbortController：
 *   ① 响应头超时（HEADER_TIMEOUT_MS）：fetch 等待响应头超过阈值 → controller.abort()
 *   ② 客户端在响应头到达前断开 → controller.abort()（取消未完成的上游 fetch）
 *
 * 方案：
 *   - vi.mock config.js 注入一个 provider（避免 env/磁盘 config 的加载时序问题）。
 *   - mock globalThis.fetch 返回永不 resolve 的 Promise（模拟上游 stall），
 *     signal 被 abort 时 reject 一个 name='AbortError' 的错误（与 undici 真实行为一致）。
 *   - 启动真实 proxy server（进程内），用 node:http 发请求。
 *   - fake timer 只替换 setTimeout/clearTimeout/setInterval/clearInterval（保留真实 I/O），
 *     用捕获的真实 setTimeout 轮询等待真实网络事件送达。
 *
 * 运行: npx vitest run tests/proxy-timeout.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import { HEADER_TIMEOUT_MS } from '../server/constants.js';

// ==================== mock config（注入测试 provider）====================

const providerConfig = vi.hoisted(() => ({
  providers: [{
    id: 'provider-timeout',
    name: 'glm',
    endpoints: {
      // baseUrl 不会被真实请求（fetch 已 mock），任意占位即可
      'anthropic-messages': 'http://127.0.0.1:9/v1',
      'openai-chat': null,
      'openai-responses': null,
    },
  }],
}));

vi.mock('../server/config.js', () => ({
  getConfig: () => ({
    host: '127.0.0.1',
    proxyPort: 0,
    webPort: 0,
    logDir: '/tmp',
    dbPath: '/tmp/lucent-proxy-timeout-test.db',
    logRetentionDays: 3,
    logMode: 'archive',
    tempLogTtlMinutes: 30,
    providers: providerConfig.providers,
  }),
  findProviderByName: (cfg: { providers: Array<{ name: string }> }, name: string) =>
    cfg.providers.find(p => p.name === name) || null,
}));

// mock 之后引入 proxy（vi.mock 会被 vitest 提升到所有 import 之前生效）
// endpoint-handlers.js 模块加载时调用 registerEndpoint 注册端点路径匹配器
// （与 server/index.ts 的 side-effect import 一致；proxy.ts 本身不导入它）
import '../server/endpoint-handlers.js';
import { startProxyServer } from '../server/proxy.js';

// ==================== 共享状态 ====================

const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const PROXY_PORT = 30000 + Math.floor(Math.random() * 30000);
let stopServer: (() => Promise<void>) | null = null;
const originalFetch = globalThis.fetch;
let mockFetchSignal: AbortSignal | undefined;
let fetchCallCount = 0;

// ==================== 工具：真实定时器轮询 ====================

/** fake timer 下等待真实 I/O：用 fake 之前捕获的真实 setTimeout 睡眠 */
function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => realSetTimeout(resolve, ms) as unknown as NodeJS.Timeout);
}

/** 用真实时钟轮询直到 fn 返回真值（避免被 fake 的 setTimeout 卡住） */
async function waitFor<T>(fn: () => T | null | undefined | false, timeoutMs = 3000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() >= deadline) throw new Error(`waitFor 超时 (${timeoutMs}ms)`);
    await realSleep(10);
  }
}

/** 安装永不 resolve 的 fetch mock（模拟上游 stall），signal 被 abort 时 reject AbortError */
function installFetchMock(): void {
  mockFetchSignal = undefined;
  fetchCallCount = 0;
  globalThis.fetch = vi.fn((_input: unknown, init?: RequestInit) => {
    fetchCallCount++;
    mockFetchSignal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal as (AbortSignal & { aborted: boolean }) | undefined;
      if (!signal) return; // 无 signal：永不 resolve
      if (signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', () => {
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    });
  }) as typeof globalThis.fetch;
}

/** 经代理发送一个带 body 的 POST 请求，返回 client request 对象（用于断开模拟） */
function sendProxyRequest(): http.ClientRequest {
  const body = JSON.stringify({ model: 'claude-test', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] });
  const req = http.request({
    host: '127.0.0.1',
    port: PROXY_PORT,
    path: '/glm/v1/messages',
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body).toString() },
  });
  req.write(body);
  req.end();
  return req;
}

// ==================== 测试套件 ====================

describe('proxy 上游超时护栏 (AbortController)', () => {
  beforeAll(async () => {
    const server = await startProxyServer({ port: PROXY_PORT, host: '127.0.0.1' });
    stopServer = server.stop;
  }, 15000);

  afterAll(async () => {
    await stopServer?.();
    stopServer = null;
  }, 10000);

  beforeEach(() => {
    // 只 fake 定时器函数，保留真实 I/O（setImmediate / nextTick 不 fake），
    // 这样真实 HTTP 请求送达 / body 读取 / 响应投递仍走真实事件循环。
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    installFetchMock();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  it('① 响应头超时：到达 HEADER_TIMEOUT_MS 时 fetch 被 abort（signal.aborted=true）', async () => {
    const req = sendProxyRequest();
    const statusPromise = new Promise<number>((resolve) => {
      req.on('response', (resp) => { resp.resume(); resolve(resp.statusCode ?? 0); });
      req.on('error', () => resolve(0));
    });

    // 等待真实 I/O 把请求送达 + 读 body + 调用 fetch
    await waitFor(() => fetchCallCount > 0);
    // 修复前置：proxy 必须把 AbortController.signal 传给 fetch（修复前 fetchOptions 无 signal）
    expect(mockFetchSignal).toBeDefined();
    const signal = mockFetchSignal!;
    expect(signal.aborted).toBe(false);

    // 推进 fake timer 到响应头超时阈值 → controller.abort()
    await vi.advanceTimersByTimeAsync(HEADER_TIMEOUT_MS);

    // signal 被 abort（同步生效）
    expect(signal.aborted).toBe(true);

    // 等真实 I/O 投递响应；AbortError → 504 Upstream Timeout
    await realSleep(50);
    const status = await Promise.race([
      statusPromise,
      realSleep(2000).then(() => -1),
    ]);
    expect(status).toBe(504);
  }, 15000);

  it('② 响应头到达前客户端断开：controller.abort 被调用（signal.aborted=true）', async () => {
    const req = sendProxyRequest();
    // 客户端主动断开会触发 socket hang up / ECONNRESET，吞掉以免污染测试输出
    req.on('error', () => {});

    await waitFor(() => fetchCallCount > 0);
    expect(mockFetchSignal).toBeDefined();
    const signal = mockFetchSignal!;
    expect(signal.aborted).toBe(false);

    // 模拟客户端在响应头到达前断开
    req.destroy();

    // res close 经真实 I/O 传播到服务端 → res.on('close') → controller.abort()
    await waitFor(() => (mockFetchSignal?.aborted ? true : false), 3000);
    expect(signal.aborted).toBe(true);
  }, 15000);
});
