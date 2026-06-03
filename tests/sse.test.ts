/**
 * SSE 端点测试
 *
 * 测试 /api/logs/stream SSE 推送 + /api/logs JSON 接口
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const BASE_URL = 'http://127.0.0.1:7049';

/**
 * 等待一段时间
 */
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('SSE 端点', () => {
  describe('GET /api/logs/stream', () => {
    it('应该返回正确的 SSE headers', async () => {
      const response = await fetch(`${BASE_URL}/api/logs/stream`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/event-stream');
      expect(response.headers.get('cache-control')).toBe('no-cache');

      // 读 body 然后关闭
      const reader = response.body?.getReader();
      if (reader) {
        reader.cancel();
      }
    });

    it('应该收到 connected 事件', async () => {
      // 用 node http 直接连接，避免 fetch 的 SSE 兼容问题
      const { default: http } = await import('node:http');
      const url = new URL('/api/logs/stream', BASE_URL);

      const received = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('timeout')), 3000);
        const req = http.get(url.toString(), (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => {
            data += chunk.toString();
            // 收到第一个事件就够了
            if (data.includes('event: connected')) {
              clearTimeout(timeout);
              req.destroy();
              resolve(data);
            }
          });
          res.on('error', reject);
        });
        req.on('error', reject);
      });

      expect(received).toContain('event: connected');
      expect(received).toContain('"timestamp"');
    });
  });

  describe('GET /api/logs (JSON)', () => {
    it('应该返回 JSON 格式日志列表', async () => {
      const response = await fetch(`${BASE_URL}/api/logs`);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data).toHaveProperty('logs');
      expect(data).toHaveProperty('total');
      expect(Array.isArray(data.logs)).toBe(true);
      expect(typeof data.total).toBe('number');
    });

    it('应该支持 agentType 过滤', async () => {
      const response = await fetch(`${BASE_URL}/api/logs?agentType=main`);
      const data = await response.json();

      expect(data.logs.every((log: any) => log.agentType === 'main')).toBe(true);
    });

    it('应该支持 limit 参数', async () => {
      const response = await fetch(`${BASE_URL}/api/logs?limit=2`);
      const data = await response.json();

      expect(data.logs.length).toBeLessThanOrEqual(2);
    });
  });

  describe('GET /api/logs/:id', () => {
    it('不存在的 id 应该返回 404', async () => {
      const response = await fetch(`${BASE_URL}/api/logs/nonexistent_id`);
      expect(response.status).toBe(404);

      const data = await response.json();
      expect(data).toHaveProperty('error');
    });
  });
});

describe('服务器状态 API', () => {
  it('GET /api/status 应该返回服务器状态', async () => {
    const response = await fetch(`${BASE_URL}/api/status`);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toHaveProperty('enabled');
    expect(data).toHaveProperty('running');
    expect(data).toHaveProperty('webPort');
    expect(data).toHaveProperty('proxyPort');
    expect(data.webPort).toBe(7049);
  });

  it('GET /api/health 应该返回健康状态', async () => {
    const response = await fetch(`${BASE_URL}/api/health`);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.status).toBe('ok');
    expect(data).toHaveProperty('uptime');
  });
});

describe('日志文件 API', () => {
  it('GET /api/log-files 应该返回文件列表', async () => {
    const response = await fetch(`${BASE_URL}/api/log-files`);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toHaveProperty('files');
    expect(Array.isArray(data.files)).toBe(true);
  });

  it('GET /api/logs/stats 应该返回统计信息', async () => {
    const response = await fetch(`${BASE_URL}/api/logs/stats`);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toHaveProperty('totalEntries');
    expect(data).toHaveProperty('totalSize');
    expect(data).toHaveProperty('fileCount');
  });
});
