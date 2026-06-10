/**
 * 配置动态更新端到端测试
 *
 * 验证：修改使用中的配置后，下一次请求会使用新的上游地址
 * 运行: vitest run tests/config-reload-e2e.test.ts
 *
 * 注意：此测试会修改 ~/.lucent/config.json，测试后会恢复原配置
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { IncomingMessage, ServerResponse } from 'node:http';

const execAsync = promisify(exec);

// ==================== 常量 ====================

const CONFIG_PATH = join(homedir(), '.lucent', 'config.json');
const CONFIG_BACKUP_PATH = join(homedir(), '.lucent', 'config.json.backup');
const PROXY_PORT = 17048;
const WEB_PORT = 17049;

// ==================== 类型定义 ====================

interface MockServer {
  server: ReturnType<typeof createServer>;
  port: number;
  requests: Array<{ url: string; method: string; headers: Record<string, string> }>;
}

interface ProxyConfig {
  groups: Array<{
    apiType: string;
    profiles: Array<{ id: string; name: string; upstreamBaseUrl: string; apiKey: string }>;
    activeProfileId: string;
  }>;
}

// ==================== 全局状态 ====================

let mockServer1: MockServer;
let mockServer2: MockServer;
let backendProcess: ChildProcess | null = null;
let originalConfig: any = null;

// ==================== 工具函数 ====================

/**
 * 创建 mock 上游服务器
 */
function createMockServer(name: string): MockServer {
  const requests: Array<{ url: string; method: string; headers: Record<string, string> }> = [];

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    requests.push({
      url: req.url || '/',
      method: req.method || 'GET',
      headers: req.headers as Record<string, string>,
    });

    // 模拟 SSE 流式响应（简化版）
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    });

    // 发送简单的 SSE 事件
    const events = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_123","role":"assistant","model":"claude-3-opus-20240229"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"OK"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
    ];

    let i = 0;
    const interval = setInterval(() => {
      if (i < events.length) {
        res.write(events[i]);
        i++;
      } else {
        clearInterval(interval);
        res.end();
      }
    }, 10);

    req.on('close', () => {
      clearInterval(interval);
    });
  };

  const server = createServer(handler);

  return { server, port: 0, requests };
}

/**
 * 启动 mock 服务器
 */
function startMockServer(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object' && 'port' in addr) {
        resolve(addr.port);
      } else {
        reject(new Error('Failed to get server port'));
      }
    });
    server.on('error', reject);
  });
}

/**
 * 通过代理发送请求
 */
async function requestViaProxy(path: string = '/v1/messages'): Promise<{ ok: boolean }> {
  try {
    const res = await fetch(`http://127.0.0.1:${PROXY_PORT}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'test-key', // 模拟认证
      },
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

/**
 * 备份并修改配置
 */
async function setupTestConfig(port1: number, port2: number): Promise<void> {
  let config: ProxyConfig;
  const dir = join(homedir(), '.lucent');

  // 确保目录存在
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  // 读取现有配置或使用默认配置
  if (existsSync(CONFIG_PATH)) {
    const content = await readFile(CONFIG_PATH, 'utf-8');
    config = JSON.parse(content);
    // 备份原配置
    await writeFile(CONFIG_BACKUP_PATH, content);
  } else {
    // 创建默认配置
    config = {
      groups: [
        {
          apiType: 'anthropic-messages',
          profiles: [],
          activeProfileId: '1',
        },
        {
          apiType: 'openai-chat',
          profiles: [],
          activeProfileId: '1',
        },
        {
          apiType: 'openai-responses',
          profiles: [],
          activeProfileId: '1',
        },
      ],
    };
  }

  // 确保配置结构正确
  const anthropicGroup = config.groups.find(g => g.apiType === 'anthropic-messages');
  if (anthropicGroup) {
    anthropicGroup.profiles = [
      { id: '1', name: 'Mock Server 1', upstreamBaseUrl: `http://127.0.0.1:${port1}`, apiKey: '' },
      { id: '2', name: 'Mock Server 2', upstreamBaseUrl: `http://127.0.0.1:${port2}`, apiKey: '' },
    ];
    anthropicGroup.activeProfileId = '1';
  }

  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
}

/**
 * 恢复原配置
 */
async function restoreOriginalConfig(): Promise<void> {
  if (existsSync(CONFIG_BACKUP_PATH)) {
    const backup = await readFile(CONFIG_BACKUP_PATH, 'utf-8');
    await writeFile(CONFIG_PATH, backup);
  }
}

/**
 * 启动后端服务器
 */
async function startBackend(): Promise<void> {
  // 先杀掉可能存在的进程
  try {
    await execAsync(`pkill -f "tsx.*server/index" || true`);
    await new Promise(resolve => setTimeout(resolve, 500));
  } catch {
    // ignore
  }

  return new Promise<void>((resolve, reject) => {
    // 使用 tsx 运行 TypeScript
    const proc = spawn('npx', ['tsx', 'server/index.ts'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        LUCENT_HOST: '127.0.0.1',
        LUCENT_PROXY_PORT: String(PROXY_PORT),
        LUCENT_WEB_PORT: String(WEB_PORT),
      },
    });

    let output = '';
    proc.stderr?.on('data', (data) => {
      output += data.toString();
    });

    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error(`Server startup timeout. Output: ${output}`));
    }, 15000);

    proc.stdout?.on('data', (data) => {
      output += data.toString();
      if (output.includes('Lucent')) {
        clearTimeout(timeout);
        backendProcess = proc;
        resolve();
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    proc.on('exit', (code) => {
      if (code && code !== 0) {
        clearTimeout(timeout);
        reject(new Error(`Server exited with code ${code}`));
      }
    });
  });
}

/**
 * 停止后端服务器
 */
async function stopBackend(): Promise<void> {
  if (backendProcess) {
    backendProcess.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  // 兜底杀掉可能残留的进程
  try {
    await execAsync(`pkill -f "tsx.*server/index" || true`);
    await new Promise(resolve => setTimeout(resolve, 200));
  } catch {
    // ignore
  }
}

// ==================== 测试套件 ====================

describe('配置动态更新 E2E 测试', () => {
  beforeAll(async () => {
    // 创建 mock 服务器
    mockServer1 = createMockServer('mock1');
    mockServer2 = createMockServer('mock2');

    mockServer1.port = await startMockServer(mockServer1.server);
    mockServer2.port = await startMockServer(mockServer2.server);

    // 设置测试配置
    await setupTestConfig(mockServer1.port, mockServer2.port);

    // 启动后端
    await startBackend();

    // 等待完全就绪
    await new Promise(resolve => setTimeout(resolve, 2000));
  }, 30000);

  afterAll(async () => {
    await stopBackend();

    mockServer1.server.close();
    mockServer2.server.close();

    await restoreOriginalConfig();
  }, 10000);

  beforeEach(() => {
    // 清空请求记录
    mockServer1.requests.length = 0;
    mockServer2.requests.length = 0;
  });

  it('初始状态：请求应发送到 Mock Server 1', async () => {
    await requestViaProxy();

    expect(mockServer1.requests.length).toBeGreaterThan(0);
    expect(mockServer2.requests.length).toBe(0);
    expect(mockServer1.requests[0].url).toContain('/v1/messages');
  });

  it('通过 API 切换活跃 profile 后，请求应发送到 Mock Server 2', async () => {
    // 切换到 profile 2
    const switchRes = await fetch(`http://127.0.0.1:${WEB_PORT}/api/config/anthropic-messages/active`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profileId: '2' }),
    });

    expect(switchRes.ok).toBe(true);

    // 等待配置生效
    await new Promise(resolve => setTimeout(resolve, 200));

    // 发送请求
    await requestViaProxy();

    expect(mockServer1.requests.length).toBe(0);
    expect(mockServer2.requests.length).toBeGreaterThan(0);
    expect(mockServer2.requests[0].url).toContain('/v1/messages');
  });

  it('通过 API 修改 profile 的 upstreamBaseUrl 后，请求应发送到新地址', async () => {
    // 先切换回 profile 1
    await fetch(`http://127.0.0.1:${WEB_PORT}/api/config/anthropic-messages/active`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profileId: '1' }),
    });

    // 修改 profile 1 的地址为 Mock Server 2
    const updateRes = await fetch(`http://127.0.0.1:${WEB_PORT}/api/config/anthropic-messages/profiles/1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        upstreamBaseUrl: `http://127.0.0.1:${mockServer2.port}`,
      }),
    });

    if (!updateRes.ok) {
      const errorText = await updateRes.text();
      console.error('Update failed:', updateRes.status, errorText);
    }

    expect(updateRes.ok).toBe(true);

    // 等待配置生效
    await new Promise(resolve => setTimeout(resolve, 200));

    // 发送请求
    await requestViaProxy();

    expect(mockServer1.requests.length).toBe(0);
    expect(mockServer2.requests.length).toBeGreaterThan(0);
  });

  it('验证配置已持久化到磁盘', async () => {
    // 读取配置文件
    const content = await readFile(CONFIG_PATH, 'utf-8');
    const config: ProxyConfig = JSON.parse(content);

    const anthropicGroup = config.groups.find(g => g.apiType === 'anthropic-messages');
    expect(anthropicGroup).toBeDefined();

    const profile1 = anthropicGroup!.profiles.find(p => p.id === '1');
    expect(profile1).toBeDefined();
    expect(profile1!.upstreamBaseUrl).toBe(`http://127.0.0.1:${mockServer2.port}`);
  });
});
