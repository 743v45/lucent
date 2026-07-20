/**
 * server/index.ts 优雅关闭顺序 + compression SSE 过滤回归测试
 *
 * 覆盖：
 * - Bug #4（数据丢失）：shutdownServer 必须先 proxyServer.stop()（停入口、等在途请求把日志入队）→
 *   drainPendingSSETasks → drainWriteQueue → closeDb → server.close。旧顺序先 closeDb 再 stop，
 *   在途请求完成后 insertLog(getDb()) 因 DB 已关抛错，被 enqueue 吞掉 → 日志丢失。
 * - Bug #13（SSE 被压缩缓冲）：compression filter 必须对 text/event-stream 短路返回 false，
 *   否则 zlib 缓冲破坏 SSE 实时推送（成批到达、心跳长时间收不到）。
 *
 * 为隔离 shutdownServer（依赖模块级 proxyServer/server 状态），mock 掉所有重依赖与 node:http
 * （避免真实 listen 绑端口），通过记录各步骤调用次序断言关停顺序。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---- hoisted mock 状态（vi.mock 工厂需在 import 前可见，故用 vi.hoisted）----
const ctx = vi.hoisted(() => ({
  order: [] as string[],
  startProxyServerMock: vi.fn(),
  proxyStopMock: vi.fn(),
  drainSSEMock: vi.fn(),
  drainWriteMock: vi.fn(),
  closeDbMock: vi.fn(),
  stopTempCleanupMock: vi.fn(),
  loadConfigMock: vi.fn(),
  resolveConfigMock: vi.fn(),
  cleanupOldLogsMock: vi.fn(),
}));

vi.mock('node:http', async (importActual) => {
  const actual = await importActual() as typeof import('node:http');
  return {
    ...actual,
    // 不真实绑端口：listen 立即触发回调；close 记入 order 以断言关停次序
    createServer: () => ({
      listen: (_port: unknown, _host: unknown, cb: (() => void) | undefined) => { if (cb) cb(); },
      on: () => {},
      close: () => { ctx.order.push('serverClose'); },
    }),
  };
});

vi.mock('../server/proxy.js', () => ({ startProxyServer: ctx.startProxyServerMock }));
vi.mock('../server/interceptor.js', () => ({ setupInterceptor: vi.fn(), drainPendingSSETasks: ctx.drainSSEMock }));
vi.mock('../server/services/log-writer.js', () => ({
  init: vi.fn(),
  cleanupOldLogs: ctx.cleanupOldLogsMock,
  getCurrentLogFile: vi.fn(() => null),
  drainWriteQueue: ctx.drainWriteMock,
}));
vi.mock('../server/services/log-reader.js', () => ({ init: vi.fn() }));
vi.mock('../server/services/db-instance.js', () => ({ closeDb: ctx.closeDbMock }));
vi.mock('../server/services/temp-cleanup-scheduler.js', () => ({
  startTempCleanupTimer: vi.fn(),
  stopTempCleanupTimer: ctx.stopTempCleanupMock,
}));
vi.mock('../server/config.js', () => ({
  loadConfig: ctx.loadConfigMock,
  resolveEffectiveConfig: ctx.resolveConfigMock,
}));
vi.mock('../server/routes/index.js', () => ({ mountRoutes: vi.fn() }));
vi.mock('../server/sse-extractor.js', () => ({ isSseDebugEnabled: vi.fn(() => false) }));
vi.mock('../server/endpoint-handlers.js', () => ({}));

import { startServer, shutdownServer, sseAwareCompressionFilter } from '../server/index.js';

describe('shutdownServer — 关停次序（Bug #4 数据丢失）', () => {
  beforeEach(() => {
    ctx.order.length = 0;
    ctx.startProxyServerMock.mockReset();
    ctx.proxyStopMock.mockReset();
    ctx.drainSSEMock.mockReset();
    ctx.drainWriteMock.mockReset();
    ctx.closeDbMock.mockReset();
    ctx.stopTempCleanupMock.mockReset();
    ctx.loadConfigMock.mockReset();
    ctx.resolveConfigMock.mockReset();
    ctx.cleanupOldLogsMock.mockReset();

    ctx.resolveConfigMock.mockReturnValue({
      proxyPort: 0, host: '127.0.0.1', webPort: 0, logDir: '/tmp/lucent-test',
      dbPath: '/tmp/lucent-test.db', providers: [],
    });
    ctx.cleanupOldLogsMock.mockResolvedValue(undefined);
    ctx.startProxyServerMock.mockResolvedValue({ stop: ctx.proxyStopMock });
    // 每个步骤在被调用时同步记入 order（await 点按调用次序落地）
    ctx.proxyStopMock.mockImplementation(async () => { ctx.order.push('proxyStop'); });
    ctx.drainSSEMock.mockImplementation(async () => { ctx.order.push('drainSSE'); });
    ctx.drainWriteMock.mockImplementation(async () => { ctx.order.push('drainWrite'); });
    ctx.closeDbMock.mockImplementation(() => { ctx.order.push('closeDb'); });
  });

  it('先 stop 代理入口 → drain SSE → drain 写队列 → closeDb → server.close（在途请求日志不丢）', async () => {
    await startServer();
    await shutdownServer();

    expect(ctx.order).toEqual(['proxyStop', 'drainSSE', 'drainWrite', 'closeDb', 'serverClose']);
  });

  it('closeDb 必须晚于 proxyServer.stop()（旧顺序先 closeDb 导致在途写入丢日志）', async () => {
    await startServer();
    await shutdownServer();

    const proxyStopIdx = ctx.order.indexOf('proxyStop');
    const closeDbIdx = ctx.order.indexOf('closeDb');
    expect(proxyStopIdx).toBeGreaterThanOrEqual(0);
    expect(closeDbIdx).toBeGreaterThan(proxyStopIdx);
  });

  it('proxyServer.stop() 必须早于 drainWriteQueue（停入口后等队列排空，而非反过来）', async () => {
    await startServer();
    await shutdownServer();

    expect(ctx.order.indexOf('proxyStop')).toBeLessThan(ctx.order.indexOf('drainWrite'));
  });
});

describe('sseAwareCompressionFilter — SSE 不被压缩（Bug #13 实时推送被缓冲）', () => {
  it('text/event-stream → false（短路，绕过默认 compressible=true）', () => {
    const res = { getHeader: () => 'text/event-stream' } as any;
    expect(sseAwareCompressionFilter({} as any, res)).toBe(false);
  });

  it('application/json → true（默认 filter 判定可压缩，非 SSE 行为不变）', () => {
    const res = { getHeader: () => 'application/json; charset=utf-8' } as any;
    expect(sseAwareCompressionFilter({} as any, res)).toBe(true);
  });

  it('无 Content-Type → 走默认 filter（不误伤）', () => {
    const res = { getHeader: () => undefined } as any;
    // 默认 filter 对 undefined 类型返回 false（compressible 判定不压缩）
    expect(sseAwareCompressionFilter({} as any, res)).toBe(false);
  });
});
