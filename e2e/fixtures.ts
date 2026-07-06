/**
 * Playwright e2e 共享栈 fixture
 *
 * 复用两处现有基础设施（不重造）：
 *  - tests/e2e-helpers.ts 的 createMockUpstream —— mock 上游 + SSE/JSON fixture 的单一真相源
 *  - scripts/verify-*-e2e.ts 的编排范式 —— 临时 config + 随机端口 + 起 backend(tsx) + vite dev
 *
 * 与 verify 脚本的关键差异：拆栈用 process-group kill（spawn detached + kill(-pid)）。
 * tsx 是个 wrapper：杀 wrapper 不杀 `node --require tsx/...` 子进程，子进程会残留并继续
 * 监听端口（baseline 自检时 provider-e2e.test.ts 的 leak 就是这个）。process-group kill
 * 把 wrapper + node 子进程 + esbuild 一起带走，端口干净释放。
 */
import { test as base, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockUpstream, type MockUpstream } from '../tests/e2e-helpers.js';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export interface LucentStack {
  /** Playwright 要访问的 Web UI 地址（vite dev，/api 代理到后端 web 端口） */
  webBaseUrl: string;
  /** 发请求穿越代理的基址（http://127.0.0.1:<proxyPort>） */
  proxyBaseUrl: string;
  /** mock 上游：spec 里 setMode / reset */
  upstream: MockUpstream;
  /** POST JSON 请求穿过代理，返回 { status, body } */
  postThroughProxy(path: string, headers: Record<string, string>, body: unknown): Promise<{ status: number; body: string }>;
  /** 读隔离日志目录里最新 jsonl 的全部 entry */
  readLogEntries(): Array<Record<string, unknown>>;
  /** 取指定 provider/endpoint 的最新一条日志 id（落盘后才有） */
  latestLogId(provider: string, endpoint: string): string | undefined;
}

/** 等子进程 stdout 命中正则（启动就绪信号）；超时则把累积输出拼进报错，便于诊断 */
function waitForStdout(proc: ChildProcess, regex: RegExp, label: string, timeoutMs = 30000): Promise<void> {
  return new Promise((resolve, reject) => {
    let out = '';
    const to = setTimeout(() => reject(new Error(`${label} 启动超时（${timeoutMs}ms 无就绪输出）。输出:\n${out.slice(-2000)}`)), timeoutMs);
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(to);
      if (err) reject(err);
      else resolve();
    };
    proc.stdout?.on('data', (d: Buffer) => { out += d.toString(); if (!done && regex.test(out)) finish(); });
    proc.stderr?.on('data', (d: Buffer) => { out += d.toString(); });
    proc.on('exit', (c) => { if (!done) finish(new Error(`${label} 进程退出 code=${c}\n输出:\n${out.slice(-2000)}`)); });
    proc.on('error', (e) => finish(e));
  });
}

/** 轮询直到端口可连 */
async function waitForPort(url: string, label: string, timeoutMs = 20000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url);
      // vite dev / 后端都可能返回任意 status（含 404/200），只要 TCP 连上即可
      if (r.status > 0) return;
    } catch { /* 端口还没起，继续轮询 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${label} 端口始终不响应: ${url}`);
}

/** process-group kill：杀整个进程组（tsx wrapper + node 子进程 + esbuild），不残留监听 */
function killGroup(proc: ChildProcess | null): void {
  if (!proc || proc.pid == null) return;
  try { process.kill(-proc.pid, 'SIGTERM'); } catch { /* 组可能已空 */ }
  try { proc.kill('SIGTERM'); } catch { /* noop */ }
}

export const test = base.extend<{ lucent: LucentStack }>({
  lucent: [
    async ({ browser }, use) => {
      const configDir = mkdtempSync(join(tmpdir(), 'lucent-ui-e2e-'));
      const logDir = join(configDir, 'logs');
      // 随机端口（与 e2e-helpers.createTestEnv 同套路，30000–55000）
      const basePort = 30000 + Math.floor(Math.random() * 25000);
      const proxyPort = basePort;
      const webPort = basePort + 1;
      const vitePort = basePort + 2;

      // mock 上游：只配 openai-chat，format='openai' 用 chat-sse/chat-json 等 mode
      const upstream = await createMockUpstream({ name: 'ui-e2e', format: 'openai' });
      const upstreamBase = `http://127.0.0.1:${upstream.port}/v1`;

      writeFileSync(
        join(configDir, 'config.json'),
        JSON.stringify({
          host: '127.0.0.1',
          proxyPort,
          webPort,
          providers: [
            {
              id: 'p-openai',
              name: 'openai',
              endpoints: { 'anthropic-messages': null, 'openai-chat': upstreamBase, 'openai-responses': null },
            },
          ],
        }),
      );

      const proxyBaseUrl = `http://127.0.0.1:${proxyPort}`;
      const webBaseUrl = `http://127.0.0.1:${vitePort}`;

      // detached:true → 子进程独立进程组；拆栈时 kill(-pid) 连子进程一起带走
      const backend = spawn('npx', ['tsx', 'server/index.ts'], {
        cwd: REPO_ROOT,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          LUCENT_CONFIG_DIR: configDir,
          LUCENT_HOST: '127.0.0.1',
          LUCENT_PROXY_PORT: String(proxyPort),
          LUCENT_WEB_PORT: String(webPort),
          LUCENT_LOG_DIR: logDir,
        },
      });
      const vite = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], {
        cwd: REPO_ROOT,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, VITE_PORT: String(vitePort), LUCENT_WEB_PORT: String(webPort) },
      });

      function readLogEntries(): Array<Record<string, unknown>> {
        if (!existsSync(logDir)) return [];
        const files = readdirSync(logDir).filter((f) => f.endsWith('.jsonl')).sort();
        if (files.length === 0) return [];
        const content = readFileSync(join(logDir, files[files.length - 1]), 'utf-8');
        return content
          .split(/\n---\n/)
          .filter((s) => s.trim().startsWith('{'))
          .map((s) => {
            try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; }
          });
      }

      const stack: LucentStack = {
        webBaseUrl,
        proxyBaseUrl,
        upstream,
        async postThroughProxy(path, headers, body) {
          const res = await fetch(`${proxyBaseUrl}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...headers },
            body: typeof body === 'string' ? body : JSON.stringify(body),
          });
          return { status: res.status, body: await res.text() };
        },
        readLogEntries,
        latestLogId(provider, endpoint) {
          const entries = readLogEntries().filter(
            (e) => e.providerName === provider && e.endpointType === endpoint,
          );
          const last = entries[entries.length - 1];
          return last?.id as string | undefined;
        },
      };

      try {
        await waitForStdout(backend, /Lucent|代理|listen|启动/i, 'backend');
        await waitForStdout(vite, /Local:|ready in/i, 'vite');
        await waitForPort(`${webBaseUrl}/`, 'vite');
        // 预热：端口可连只代表 dev server 起来了，不代表模块图编完。首屏 page.goto 默认
        // 15s 超时，而 vite 冷启要现做 optimizeDeps + 按需 transform 整张模块图（App、各组件、
        // @lobehub/ui 一堆），负载一高就破 15s，排在前头的 spec 扛冷启成本时偶发挂 CI。
        // 起栈时用真实浏览器把首屏完整加载一次——让 vite 把测试会请求到的整张图（含动态
        // import / CSS / 深层组件）全 transform 完并缓存，spec 里的 goto 进来就是热的。
        // （只 fetch 入口 + main 模块不够：传递依赖仍是冷的，实跑验证过。）
        {
          const warmup = await browser.newPage();
          try {
            await warmup.goto(webBaseUrl, { waitUntil: 'load', timeout: 60_000 });
          } finally {
            await warmup.close();
          }
        }
        await use(stack);
      } finally {
        killGroup(backend);
        killGroup(vite);
        await upstream.close();
        await new Promise((r) => setTimeout(r, 400));
        try { rmSync(configDir, { recursive: true, force: true }); } catch { /* noop */ }
      }
    },
    { scope: 'worker' },
  ],
});

export { expect };
