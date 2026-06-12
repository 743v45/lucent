/**
 * 配置动态更新 E2E 测试
 *
 * 验证: 运行时通过 API 修改 provider 端点后，下一次请求使用新的上游地址
 * 运行: vitest run tests/config-reload-e2e.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';

// ==================== 常量 ====================

const CONFIG_DIR = join(homedir(), '.lucent-config-reload-e2e');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');
const PROXY_PORT = 17048;
const WEB_PORT = 17049;

// ==================== 类型 ====================

interface MockServer {
  server: ReturnType<typeof createServer>;
  port: number;
  requests: Array<{ url: string; method: string; headers: Record<string, string> }>;
}

// ==================== 全局状态 ====================

let mock1: MockServer;
let mock2: MockServer;
let backendProcess: ChildProcess | null = null;

// ==================== Mock 服务器 ====================

function createMock(name: string): MockServer {
  const requests: MockServer['requests'] = [];

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    requests.push({
      url: req.url || '/',
      method: req.method || 'GET',
      headers: req.headers as Record<string, string>,
    });

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    });

    const events = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_test","role":"assistant"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"OK from ' + name + '"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
    ];

    let i = 0;
    const interval = setInterval(() => {
      if (i < events.length) { res.write(events[i]); i++; }
      else { clearInterval(interval); res.end(); }
    }, 10);

    req.on('close', () => clearInterval(interval));
  };

  const server = createServer(handler);
  return { server, port: 0, requests };
}

function startMock(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object' && 'port' in addr) resolve(addr.port);
      else reject(new Error('No port'));
    });
    server.on('error', reject);
  });
}

// ==================== 工具函数 ====================

async function proxyRequest(): Promise<{ ok: boolean }> {
  try {
    const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/glm/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-3-opus-20240229',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });
    return { ok: res.ok };
  } catch {
    return { ok: false };
  }
}

async function writeConfig(mockPort: number): Promise<void> {
  const dir = CONFIG_DIR;
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });

  await writeFile(CONFIG_PATH, JSON.stringify({
    host: '127.0.0.1',
    proxyPort: PROXY_PORT,
    webPort: WEB_PORT,
    providers: [
      {
        id: 'provider-glm',
        name: 'glm',
        endpoints: {
          'anthropic-messages': `http://127.0.0.1:${mockPort}`,
          'openai-chat': null,
          'openai-responses': null,
        },
      },
    ],
  }, null, 2));
}

async function readConfig(): Promise<any> {
  const content = await readFile(CONFIG_PATH, 'utf-8');
  return JSON.parse(content);
}

async function cleanTestDir(): Promise<void> {
  if (existsSync(CONFIG_DIR)) await rm(CONFIG_DIR, { recursive: true, force: true });
  await mkdir(CONFIG_DIR, { recursive: true });
}

async function startBackend(): Promise<void> {
  if (backendProcess) {
    backendProcess.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 500));
  }

  return new Promise<void>((resolve, reject) => {
    const proc = spawn('npx', ['tsx', 'server/index.ts'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        LUCENT_CONFIG_DIR: CONFIG_DIR,
        LUCENT_HOST: '127.0.0.1',
        LUCENT_PROXY_PORT: String(PROXY_PORT),
        LUCENT_WEB_PORT: String(WEB_PORT),
      },
    });

    let output = '';
    proc.stderr?.on('data', (d) => { output += d.toString(); });

    const timeout = setTimeout(() => { proc.kill(); reject(new Error(`Timeout: ${output}`)); }, 15000);

    proc.stdout?.on('data', (d) => {
      output += d.toString();
      if (output.includes('Lucent')) { clearTimeout(timeout); backendProcess = proc; resolve(); }
    });

    proc.on('error', (err) => { clearTimeout(timeout); reject(err); });
    proc.on('exit', (code) => { if (code && code !== 0) { clearTimeout(timeout); reject(new Error(`Exit: ${code}`)); } });
  });
}

async function stopBackend(): Promise<void> {
  if (backendProcess) {
    backendProcess.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 500));
    backendProcess = null;
  }
}

// ==================== 测试套件 ====================

describe('配置动态更新 E2E 测试', () => {
  beforeAll(async () => {
    mock1 = createMock('mock1');
    mock2 = createMock('mock2');

    mock1.port = await startMock(mock1.server);
    mock2.port = await startMock(mock2.server);

    // 初始配置: glm → mock1
    await cleanTestDir();
    await writeConfig(mock1.port);

    await startBackend();
    await new Promise(r => setTimeout(r, 2000));
  }, 30000);

  afterAll(async () => {
    await stopBackend();
    mock1.server.close();
    mock2.server.close();
    await cleanTestDir();
  }, 10000);

  beforeEach(() => {
    mock1.requests.length = 0;
    mock2.requests.length = 0;
  });

  it('初始状态: 请求应发送到 Mock 1', async () => {
    await proxyRequest();

    expect(mock1.requests.length).toBeGreaterThan(0);
    expect(mock2.requests.length).toBe(0);
  });

  it('通过 PUT API 修改端点后，请求应发送到 Mock 2', async () => {
    // 通过 REST API 修改 glm 的 anthropic-messages 端点指向 mock2
    const res = await fetch(`http://127.0.0.1:${WEB_PORT}/api/providers/glm`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        endpoints: {
          'anthropic-messages': `http://127.0.0.1:${mock2.port}`,
          'openai-chat': null,
          'openai-responses': null,
        },
      }),
    });
    expect(res.ok).toBe(true);

    // 等待配置生效
    await new Promise(r => setTimeout(r, 200));

    await proxyRequest();

    expect(mock1.requests.length).toBe(0);
    expect(mock2.requests.length).toBeGreaterThan(0);
  });

  it('验证配置已持久化到磁盘', async () => {
    const config = await readConfig();
    const glm = config.providers.find((p: any) => p.name === 'glm');
    expect(glm).toBeDefined();
    expect(glm.endpoints['anthropic-messages']).toBe(`http://127.0.0.1:${mock2.port}`);
  });

  it('通过 PUT API 切换回 Mock 1 后，请求应回到 Mock 1', async () => {
    const res = await fetch(`http://127.0.0.1:${WEB_PORT}/api/providers/glm`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        endpoints: {
          'anthropic-messages': `http://127.0.0.1:${mock1.port}`,
          'openai-chat': null,
          'openai-responses': null,
        },
      }),
    });
    expect(res.ok).toBe(true);

    await new Promise(r => setTimeout(r, 200));

    await proxyRequest();

    expect(mock1.requests.length).toBeGreaterThan(0);
    expect(mock2.requests.length).toBe(0);
  });
});
