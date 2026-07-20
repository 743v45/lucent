/**
 * 回归测试：客户端断开 → controller.abort 传播到 tee 的 logBranch（承接 high #6）
 *
 * 背景：interceptor 对流式 response.body.tee()：clientBranch 给 proxy 透传，
 * logBranch 交 collectSSELinesInBackground 收集日志。high #6 在 proxy.ts 的 res.on('close')
 * 加了 controller.abort()。本测验证：流式透传「期间」客户端断开时，controller.abort 会让
 * fetch 的 response.body 源流 error，并全量传播到 tee 两个 branch（WHATWG Streams
 * 「源 error 全量传播」语义），从而：
 *   ① collectSSELinesInBackground（消费 logBranch）秒级停止，不被拖到 SSE_COLLECT_TIMEOUT_MS(180s)；
 *   ② 上游 socket 关闭（不再空烧上游 token 配额）。
 *
 * 注：消费端单 branch cancel 不会取消 tee 源（"两 branch 都 cancel 才取消源"）——
 * 但 fetch abort 属「源侧 error」，与消费端 cancel 语义不同，会同时终止两个 branch。
 *
 * 两层覆盖：
 *   - 平台层（真实 fetch + tee + collectSSELinesInBackground + abort）
 *   - 代理接线层（真实 proxy server + 真实上游 + 模拟 interceptor 的 tee，客户端真实断开）
 *
 * 运行: npx vitest run tests/proxy-stream-abort.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import { collectSSELinesInBackground } from '../server/sse-extractor.js';
import type { RawLogEntry } from '../server/types.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** 真实时钟轮询直到 fn 返回真值 */
async function waitFor<T>(
  fn: () => T | null | undefined | false,
  timeoutMs = 3000,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() >= deadline) throw new Error(`waitFor 超时 (${timeoutMs}ms)`);
    await sleep(10);
  }
}

function makeEntry(url: string): RawLogEntry {
  return {
    id: `abort-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    project: '',
    url,
    method: 'POST',
    headers: {},
    body: null,
    response: null,
    duration: 0,
    isStream: true,
    mainAgent: false,
    endpointType: 'anthropic-messages',
  };
}

/** 起一个持续吐 SSE 的慢速上游，返回关闭事件计数（用于断言上游 socket 是否被取消） */
function startSlowUpstream(port: number, host = '127.0.0.1'): {
  server: http.Server;
  closeCount: () => number;
} {
  let connections = 0;
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const iv = setInterval(() => {
      res.write(`event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"x"}}\n\n`);
    }, 50);
    res.on('close', () => { connections += 1; clearInterval(iv); });
  });
  return { server, closeCount: () => connections };
}

const freePort = (base: number) => base + Math.floor(Math.random() * 1500);

// ==================== mock config（代理接线层用：provider 指向真实上游）====================

const providerConfig = vi.hoisted(() => ({
  providers: [{
    id: 'provider-abort',
    name: 'glm',
    endpoints: {
      'anthropic-messages': '', // beforeAll 里填上游端口
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
    dbPath: '/tmp/lucent-proxy-stream-abort-test.db',
    logRetentionDays: 3,
    logMode: 'archive',
    tempLogTtlMinutes: 30,
    providers: providerConfig.providers,
  }),
  findProviderByName: (cfg: { providers: Array<{ name: string }> }, name: string) =>
    cfg.providers.find(p => p.name === name) || null,
}));

// vi.mock 提升到所有 import 之前生效；注册端点路径匹配器（与 server/index.ts 一致）
import '../server/endpoint-handlers.js';
import { startProxyServer } from '../server/proxy.js';

// ==================== 平台层：fetch + tee + collectSSELinesInBackground + abort ====================

describe('客户端断开 abort 传播到 tee logBranch（承接 high #6）', () => {
  describe('平台层：fetch abort 让 tee 源流 error → 两 branch 同时终止', () => {
    it('abort 后 collectSSELinesInBackground 秒级结束 + 上游连接关闭', async () => {
      const PORT = freePort(40000);
      const { server, closeCount } = startSlowUpstream(PORT);
      await new Promise<void>(r => server.listen(PORT, '127.0.0.1', r));
      const url = `http://127.0.0.1:${PORT}/`;

      try {
        const controller = new AbortController();
        const response = await fetch(url, { method: 'POST', signal: controller.signal });

        // 还原 interceptor：response.body.tee()
        const [clientBody, logBody] = response.body!.tee();

        // 还原 proxy：后台消费 clientBody（透传管道）
        const clientReader = clientBody.getReader();
        (async () => {
          try {
            for (;;) {
              const { done } = await clientReader.read();
              if (done) break;
            }
          } catch {
            /* abort 后 branch error，吞掉 */
          }
        })();

        // 还原 interceptor：logBody 交给 collectSSELinesInBackground
        const entry = makeEntry(url);
        let finishedAt: number | null = null;
        const collectPromise = collectSSELinesInBackground(
          logBody, entry, Date.now(), () => {}, () => {},
        );
        collectPromise.finally(() => { finishedAt = Date.now(); });

        await sleep(300); // 等流跑起来

        const abortAt = Date.now();
        controller.abort(); // 模拟 proxy res.on('close') → controller.abort()

        // collectSSELinesInBackground 应在 2s 内结束（远小于 180s 收集超时）
        await waitFor(() => (finishedAt !== null ? true : false), 2500);
        expect(finishedAt).not.toBeNull();
        expect(finishedAt! - abortAt).toBeLessThan(2000);

        // 上游 socket 关闭（abort 关闭了 fetch 的底层连接）
        await waitFor(() => closeCount() > 0, 2500);
        expect(closeCount()).toBeGreaterThan(0);
      } finally {
        server.closeAllConnections();
        server.close();
      }
    }, 12000);

    // 注：未设「仅 cancel 单 branch」对照组——Node web-streams 实现里 cancel 单个 tee branch
    // 不会顺滑 resolve（实测会悬挂），这恰恰说明：消费端单 branch cancel 既不取消源也不可靠，
    // 必须用 controller.abort()（源侧 error）同时终止两个 branch。proxy.ts 的注释已说明此点。
  });

  // ==================== 代理接线层：真实 proxy + 真实上游 + 客户端真实断开 ====================

  describe('代理接线层：流式透传期间客户端断开 → controller.abort 传播', () => {
    const PROXY_PORT = freePort(30000);
    const realFetch = globalThis.fetch.bind(globalThis);
    let stopServer: (() => Promise<void>) | null = null;
    let upstreamSrv: http.Server | null = null;
    let upstreamCloseCount = 0;
    // 本轮 collectSSELinesInBackground 的结束时间（mock fetch 内写入、用例内断言）
    let collectFinishedAt: number | null = null;

    beforeAll(async () => {
      // 起真实慢速上游，并把 provider baseUrl 指向它
      const upstreamPort = freePort(47000);
      providerConfig.providers[0].endpoints['anthropic-messages'] =
        `http://127.0.0.1:${upstreamPort}/v1`;
      upstreamSrv = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const iv = setInterval(() => {
          res.write(`event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"x"}}\n\n`);
        }, 50);
        res.on('close', () => { upstreamCloseCount++; clearInterval(iv); });
      });
      await new Promise<void>(r => upstreamSrv!.listen(upstreamPort, '127.0.0.1', r));

      // mock globalThis.fetch：模拟 interceptor 的 tee（真实 fetch 上游 + tee + collectSSELinesInBackground）
      globalThis.fetch = (async (u: URL | RequestInfo, init?: RequestInit) => {
        const upstreamRes = await realFetch(u, init);
        if (!upstreamRes.body) return upstreamRes;
        const [clientBody, logBody] = upstreamRes.body.tee();
        const entry = makeEntry(typeof u === 'string' ? u : String(u));
        collectFinishedAt = null;
        const task = collectSSELinesInBackground(
          logBody, entry, Date.now(), () => {}, () => {},
        );
        task.finally(() => { collectFinishedAt = Date.now(); });
        return new Response(clientBody, {
          status: upstreamRes.status,
          statusText: upstreamRes.statusText,
          headers: upstreamRes.headers,
        });
      }) as typeof globalThis.fetch;

      const server = await startProxyServer({ port: PROXY_PORT, host: '127.0.0.1' });
      stopServer = server.stop;
    }, 20000);

    afterAll(async () => {
      globalThis.fetch = realFetch;
      await stopServer?.();
      stopServer = null;
      await new Promise<void>(r => {
        upstreamSrv?.closeAllConnections();
        upstreamSrv?.close(() => r());
      });
    }, 15000);

    it('客户端在收到响应头后断开 → logBranch 秒级结束 + 上游 socket 关闭', async () => {
      const body = JSON.stringify({
        model: 'claude-test', max_tokens: 1, stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      });
      const req = http.request({
        host: '127.0.0.1', port: PROXY_PORT,
        path: '/glm/v1/messages', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body).toString() },
      });
      req.on('error', () => {}); // 客户端主动断开会触发 ECONNRESET，吞掉

      // 等响应头到达（proxy 已开始流式透传）
      const gotHeaders = new Promise<boolean>(resolve => {
        req.on('response', () => resolve(true));
      });
      req.write(body);
      req.end();
      await gotHeaders;

      const closeBefore = upstreamCloseCount;
      const disconnectAt = Date.now();
      // 客户端在流式透传期间断开（长输出/长思考提前退出的场景）
      req.destroy();

      // logBranch（collectSSELinesInBackground）应秒级结束，不被拖到 180s
      await waitFor(() => (collectFinishedAt !== null ? true : false), 3000);
      expect(collectFinishedAt).not.toBeNull();
      expect(collectFinishedAt! - disconnectAt).toBeLessThan(2500);

      // 上游 socket 关闭（controller.abort 经 fetch 传播，关闭上游连接）
      await waitFor(() => upstreamCloseCount > closeBefore, 3000);
      expect(upstreamCloseCount).toBeGreaterThan(closeBefore);
    }, 15000);
  });
});
