/**
 * AgentProxy API 测试
 *
 * 运行方式: node tests/api.test.mjs
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const BASE_URL = 'http://127.0.0.1:7049';
let serverProcess = null;

describe('AgentProxy API Tests', () => {
  before(async () => {
    // 启动服务器
    const { spawn } = await import('child_process');
    serverProcess = spawn('node', ['server/index.js'], {
      stdio: 'pipe',
    });

    // 等待服务器启动
    await new Promise(resolve => setTimeout(resolve, 2000));
  });

  after(async () => {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  });

  it('GET /api/health should return health status', async () => {
    const res = await fetch(`${BASE_URL}/api/health`);
    const data = await res.json();

    assert.equal(res.status, 200);
    assert.equal(data.status, 'ok');
    assert.ok(data.timestamp);
    assert.ok(typeof data.uptime === 'number');
  });

  it('GET /api/status should return proxy status', async () => {
    const res = await fetch(`${BASE_URL}/api/status`);
    const data = await res.json();

    assert.equal(res.status, 200);
    assert.ok(typeof data.enabled === 'boolean');
    assert.ok(data.running);
    assert.equal(data.webPort, 7049);
    assert.equal(data.proxyPort, 7048);
    assert.ok(typeof data.connectedClients === 'number');
  });

  it('POST /api/enable should enable proxy', async () => {
    const res = await fetch(`${BASE_URL}/api/enable`, { method: 'POST' });
    const data = await res.json();

    assert.equal(res.status, 200);
    assert.equal(data.success, true);
    assert.equal(data.enabled, true);
  });

  it('POST /api/disable should disable proxy', async () => {
    const res = await fetch(`${BASE_URL}/api/disable`, { method: 'POST' });
    const data = await res.json();

    assert.equal(res.status, 200);
    assert.equal(data.success, true);
    assert.equal(data.enabled, false);
  });

  it('GET /api/logs should return logs array', async () => {
    const res = await fetch(`${BASE_URL}/api/logs`);
    const data = await res.json();

    assert.equal(res.status, 200);
    assert.ok(Array.isArray(data.logs));
    assert.ok(typeof data.total === 'number');
  });

  it('GET /api/logs with pagination should work', async () => {
    const res = await fetch(
      `${BASE_URL}/api/logs?limit=10&offset=0`
    );
    const data = await res.json();

    assert.equal(res.status, 200);
    assert.ok(data.logs.length <= 10);
  });

  it('GET /api/logs with filters should work', async () => {
    const res = await fetch(
      `${BASE_URL}/api/logs?agentType=all&limit=5`
    );
    const data = await res.json();

    assert.equal(res.status, 200);
    assert.ok(Array.isArray(data.logs));
  });

  it('GET /api/log-files should return file list', async () => {
    const res = await fetch(`${BASE_URL}/api/log-files`);
    const data = await res.json();

    assert.equal(res.status, 200);
    assert.ok(Array.isArray(data.files));
  });
});

console.log('✅ API 测试完成');
