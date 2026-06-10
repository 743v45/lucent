/**
 * Provider 重构 E2E 测试
 *
 * 验证多供应商 + 自定义路由架构:
 * 1. 配置 CRUD:新建/重命名(冲突拒绝)/更新/删除
 * 2. 路由命中: /custom/{name}/{rest} → 正确端点
 * 3. 鉴权头注入: 不同 endpointType header 是否正确
 * 4. 日志落盘: providerName + endpointType
 * 5. 首次启动: 无配置时创建默认 anthropic 供应商
 *
 * 运行: vitest run tests/provider-e2e.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { IncomingMessage, ServerResponse } from 'node:http';

const execAsync = promisify(exec);

// ==================== 常量 ====================

const CONFIG_DIR = join(homedir(), '.lucent-e2e-test');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');
const LOG_DIR = join(CONFIG_DIR, 'logs');
const PROXY_PORT = 18048;
const WEB_PORT = 18049;

// ==================== 类型定义 ====================

interface MockUpstream {
  server: Server;
  port: number;
  requests: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
  }>;
}

interface Provider {
  id: string;
  name: string;
  apiKey: string;
  endpoints: Record<string, string | null>;
}

interface ProxyConfig {
  host: string;
  proxyPort: number;
  webPort: number;
  providers: Provider[];
}

// ==================== 全局状态 ====================

let mockAnthropic: MockUpstream;
let mockOpenAI: MockUpstream;
let backendProcess: ChildProcess | null = null;

// ==================== 工具函数 ====================

/**
 * 创建 mock 上游服务器
 */
function createMockUpstream(name: string): MockUpstream {
  const requests: MockUpstream['requests'] = [];

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    // 收集请求信息
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString();

    requests.push({
      url: req.url || '/',
      method: req.method || 'GET',
      headers: req.headers as Record<string, string>,
      body,
    });

    // 返回 SSE 流式响应（简化版 Anthropic/OpenAI 格式）
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    });

    const events = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_test","role":"assistant"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"OK from ' + name + '"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
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

    req.on('close', () => clearInterval(interval));
  };

  return { server: createServer(handler), port: 0, requests };
}

/**
 * 启动 mock 服务器
 */
function startMockServer(server: Server): Promise<number> {
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
 * 通过代理发送请求到自定义路径
 */
async function requestViaProxy(
  providerName: string,
  path: string,
  options?: { headers?: Record<string, string>; body?: unknown },
): Promise<{ status: number; body: unknown }> {
  try {
    const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/custom/${providerName}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...options?.headers,
      },
      body: JSON.stringify(options?.body ?? {
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });

    const body = await res.text();
    return { status: res.status, body: body ? JSON.parse(body) : null };
  } catch (err) {
    return { status: 0, body: { error: String(err) } };
  }
}

/**
 * 调用 Web API
 */
async function apiRequest(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  try {
    const res = await fetch(`http://127.0.0.1:${WEB_PORT}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const responseBody = await res.text();
    return { status: res.status, body: responseBody ? JSON.parse(responseBody) : null };
  } catch (err) {
    return { status: 0, body: { error: String(err) } };
  }
}

/**
 * 清空测试目录
 */
async function cleanTestDir(): Promise<void> {
  if (existsSync(CONFIG_DIR)) {
    await rm(CONFIG_DIR, { recursive: true, force: true });
  }
  await mkdir(CONFIG_DIR, { recursive: true });
  await mkdir(LOG_DIR, { recursive: true });
}

/**
 * 写入测试配置
 */
async function writeTestConfig(config: ProxyConfig): Promise<void> {
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
}

/**
 * 读取当前配置
 */
async function readTestConfig(): Promise<ProxyConfig | null> {
  if (!existsSync(CONFIG_PATH)) return null;
  const content = await readFile(CONFIG_PATH, 'utf-8');
  return JSON.parse(content);
}

/**
 * 读取最新的日志文件
 */
async function readLatestLog(): Promise<Array<{ providerName?: string; endpointType?: string }> | null> {
  const files = await readdir(LOG_DIR);
  const jsonlFiles = files.filter(f => f.endsWith('.jsonl')).sort().reverse();
  if (jsonlFiles.length === 0) return null;

  const content = await readFile(join(LOG_DIR, jsonlFiles[0]), 'utf-8');
  const lines = content.split('\n').filter(Boolean);
  return lines.map(line => {
    try {
      const obj = JSON.parse(line);
      return { providerName: obj.providerName, endpointType: obj.endpointType };
    } catch {
      return {};
    }
  });
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
    const proc = spawn('npx', ['tsx', 'server/index.ts'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        LUCENT_CONFIG_DIR: CONFIG_DIR,
        LUCENT_HOST: '127.0.0.1',
        LUCENT_PROXY_PORT: String(PROXY_PORT),
        LUCENT_WEB_PORT: String(WEB_PORT),
        LUCENT_LOG_DIR: LOG_DIR,
      },
    });

    let output = '';
    proc.stderr?.on('data', (data) => {
      output += data.toString();
    });

    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error(`Server startup timeout. Output: ${output}`));
    }, 20000);

    proc.stdout?.on('data', (data) => {
      output += data.toString();
      if (output.includes('Lucent') || output.includes('代理')) {
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
  try {
    await execAsync(`pkill -f "tsx.*server/index" || true`);
    await new Promise(resolve => setTimeout(resolve, 200));
  } catch {
    // ignore
  }
}

// ==================== 测试套件 ====================

describe('Provider E2E 测试', () => {
  beforeAll(async () => {
    // 创建 mock 上游服务器
    mockAnthropic = createMockUpstream('anthropic');
    mockOpenAI = createMockUpstream('openai');

    mockAnthropic.port = await startMockServer(mockAnthropic.server);
    mockOpenAI.port = await startMockServer(mockOpenAI.server);

    // 清空并写入初始配置
    await cleanTestDir();
    await writeTestConfig({
      host: '127.0.0.1',
      proxyPort: PROXY_PORT,
      webPort: WEB_PORT,
      providers: [
        {
          id: 'provider-glm',
          name: 'glm',
          apiKey: 'sk-glm-test-key',
          endpoints: {
            'anthropic-messages': `http://127.0.0.1:${mockAnthropic.port}`,
            'openai-chat': `http://127.0.0.1:${mockOpenAI.port}`,
            'openai-responses': null, // GLM 不支持 responses
          },
        },
      ],
    });

    // 启动后端
    await startBackend();

    // 等待完全就绪
    await new Promise(resolve => setTimeout(resolve, 2000));
  }, 30000);

  afterAll(async () => {
    await stopBackend();

    mockAnthropic.server.close();
    mockOpenAI.server.close();

    await cleanTestDir();
  }, 10000);

  beforeEach(() => {
    // 清空请求记录
    mockAnthropic.requests.length = 0;
    mockOpenAI.requests.length = 0;
  });

  // ==================== 路由命中测试 ====================

  describe('路由命中', () => {
    it('/custom/glm/v1/messages → 命中 anthropic-messages 端点', async () => {
      const res = await requestViaProxy('glm', '/v1/messages');
      expect(res.status).toBe(200);

      expect(mockAnthropic.requests.length).toBeGreaterThan(0);
      expect(mockAnthropic.requests[0].url).toBe('/v1/messages');
      expect(mockAnthropic.requests[0].headers['x-api-key']).toBe('sk-glm-test-key');
      expect(mockAnthropic.requests[0].headers['anthropic-version']).toBeDefined();
    });

    it('/custom/glm/v1/chat/completions → 命中 openai-chat 端点', async () => {
      const res = await requestViaProxy('glm', '/v1/chat/completions');
      expect(res.status).toBe(200);

      expect(mockOpenAI.requests.length).toBeGreaterThan(0);
      expect(mockOpenAI.requests[0].url).toBe('/v1/chat/completions');
      expect(mockOpenAI.requests[0].headers['authorization']).toBe('Bearer sk-glm-test-key');
    });

    it('/custom/glm/v1/responses (GLM 未配) → 404', async () => {
      const res = await requestViaProxy('glm', '/v1/responses');
      expect(res.status).toBe(404);
      expect((res.body as { error: string }).error).toContain('does not support');
    });

    it('/custom/unknown/v1/messages → 404 (provider not found)', async () => {
      const res = await requestViaProxy('unknown', '/v1/messages');
      expect(res.status).toBe(404);
      expect((res.body as { error: string }).error).toContain('not found');
    });

    it('/v1/messages 裸路径 → 404 + 提示', async () => {
      const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'test', messages: [] }),
      });
      expect(res.status).toBe(404);
      const body = await res.json() as { error: string };
      expect(body.error).toContain('/custom/{name}');
    });
  });

  // ==================== 鉴权头注入测试 ====================

  describe('鉴权头注入', () => {
    it('anthropic-messages: x-api-key + anthropic-version', async () => {
      await requestViaProxy('glm', '/v1/messages');

      expect(mockAnthropic.requests[0].headers['x-api-key']).toBe('sk-glm-test-key');
      expect(mockAnthropic.requests[0].headers['anthropic-version']).toBeDefined();
      // 下游的 authorization 应被清除
      expect(mockAnthropic.requests[0].headers['authorization']).toBeUndefined();
    });

    it('openai-chat: Authorization Bearer', async () => {
      await requestViaProxy('glm', '/v1/chat/completions');

      expect(mockOpenAI.requests[0].headers['authorization']).toBe('Bearer sk-glm-test-key');
      expect(mockOpenAI.requests[0].headers['x-api-key']).toBeUndefined();
    });
  });

  // ==================== 配置 CRUD 测试 ====================

  describe('配置 CRUD', () => {
    it('GET /api/providers → 列出脱敏 providers', async () => {
      const res = await apiRequest('GET', '/api/providers');
      expect(res.status).toBe(200);

      const body = res.body as { providers: Provider[] };
      expect(body.providers.length).toBeGreaterThan(0);
      expect(body.providers[0].name).toBe('glm');
      // apiKey 应脱敏
      expect(body.providers[0].apiKey).not.toBe('sk-glm-test-key');
    });

    it('POST /api/providers → 新增 provider', async () => {
      const res = await apiRequest('POST', '/api/providers', {
        name: 'deepseek',
        apiKey: 'sk-deepseek-key',
        endpoints: {
          'openai-chat': 'https://api.deepseek.com',
          'anthropic-messages': null,
          'openai-responses': null,
        },
      });
      expect(res.status).toBe(200);

      const config = await readTestConfig();
      const deepseek = config?.providers.find(p => p.name === 'deepseek');
      expect(deepseek).toBeDefined();
      expect(deepseek?.apiKey).toBe('sk-deepseek-key');
    });

    it('POST /api/providers 重复 name → 409 冲突', async () => {
      const res = await apiRequest('POST', '/api/providers', {
        name: 'deepseek', // 已存在
        apiKey: 'sk-other',
        endpoints: { 'openai-chat': 'https://other.com' },
      });
      expect(res.status).toBe(409);
    });

    it('PUT /api/providers/:name → 更新 apiKey/endpoints', async () => {
      const res = await apiRequest('PUT', '/api/providers/deepseek', {
        apiKey: 'sk-deepseek-new',
        endpoints: {
          'openai-chat': 'https://api.deepseek.com/v2',
        },
      });
      expect(res.status).toBe(200);

      const config = await readTestConfig();
      const deepseek = config?.providers.find(p => p.name === 'deepseek');
      expect(deepseek?.apiKey).toBe('sk-deepseek-new');
    });

    it('POST /api/providers/:name/rename → 重命名', async () => {
      const res = await apiRequest('POST', '/api/providers/deepseek/rename', {
        newName: 'deepseek-v2',
      });
      expect(res.status).toBe(200);

      const config = await readTestConfig();
      expect(config?.providers.find(p => p.name === 'deepseek')).toBeUndefined();
      expect(config?.providers.find(p => p.name === 'deepseek-v2')).toBeDefined();
    });

    it('DELETE /api/providers/:name → 删除', async () => {
      const res = await apiRequest('DELETE', '/api/providers/deepseek-v2');
      expect(res.status).toBe(200);

      const config = await readTestConfig();
      expect(config?.providers.find(p => p.name === 'deepseek-v2')).toBeUndefined();
    });
  });

  // ==================== 日志落盘测试 ====================

  describe('日志落盘', () => {
    it('请求后日志含 providerName + endpointType', async () => {
      // 发一个请求
      await requestViaProxy('glm', '/v1/messages');

      // 等待日志写入
      await new Promise(resolve => setTimeout(resolve, 500));

      const logs = await readLatestLog();
      expect(logs).not.toBeNull();
      expect(logs?.length).toBeGreaterThan(0);

      const latestLog = logs?.[logs!.length - 1];
      expect(latestLog?.providerName).toBe('glm');
      expect(latestLog?.endpointType).toBe('anthropic-messages');
    });
  });
});

// ==================== 首次启动测试 ====================

describe('首次启动:无配置时创建默认 anthropic 供应商', () => {
  let standaloneBackend: ChildProcess | null = null;

  beforeAll(async () => {
    await stopBackend();
    await cleanTestDir();
    // 不写入任何配置,让后端从空开始
  }, 10000);

  afterAll(async () => {
    if (standaloneBackend) {
      standaloneBackend.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    await cleanTestDir();
  }, 10000);

  it('启动后应创建默认 anthropic 供应商', async () => {
    // 启动后端(无配置)
    standaloneBackend = spawn('npx', ['tsx', 'server/index.ts'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        LUCENT_CONFIG_DIR: CONFIG_DIR,
        LUCENT_HOST: '127.0.0.1',
        LUCENT_PROXY_PORT: String(19048),
        LUCENT_WEB_PORT: String(19049),
      },
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Server startup timeout'));
      }, 15000);

      standaloneBackend.stdout?.on('data', () => {
        clearTimeout(timeout);
        resolve();
      });

      standaloneBackend.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    // 等待配置初始化
    await new Promise(resolve => setTimeout(resolve, 1000));

    // 检查配置文件
    const config = await readTestConfig();
    expect(config).not.toBeNull();
    expect(config?.providers.length).toBeGreaterThan(0);

    // 应有名为 'anthropic' 的默认供应商
    const defaultProvider = config?.providers.find(p => p.name === 'anthropic');
    expect(defaultProvider).toBeDefined();
    expect(defaultProvider?.endpoints['anthropic-messages']).toBeDefined();
  }, 20000);
});