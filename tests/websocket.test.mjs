/**
 * AgentProxy WebSocket 测试
 *
 * 运行方式: node tests/websocket.test.mjs
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { WebSocket } from 'ws';
import { spawn } from 'child_process';

const WS_URL = 'ws://127.0.0.1:7049';
let serverProcess = null;

describe('AgentProxy WebSocket Tests', () => {
  before(async () => {
    // 启动服务器
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

  it('WebSocket connection should succeed', async () => {
    const ws = new WebSocket(WS_URL);

    await new Promise((resolve, reject) => {
      ws.on('open', () => {
        ws.close();
        resolve();
      });

      ws.on('error', reject);
    });
  });

  it('should receive welcome message on connect', async () => {
    const ws = new WebSocket(WS_URL);

    const message = await new Promise((resolve, reject) => {
      ws.on('message', data => {
        try {
          const msg = JSON.parse(data.toString());
          resolve(msg);
        } catch (e) {
          reject(e);
        }
      });

      ws.on('error', reject);
    });

    assert.equal(message.type, 'connected');
    assert.ok(message.timestamp);
    assert.ok(typeof message.clients === 'number');

    ws.close();
  });

  it('should receive ping from server', async () => {
    const ws = new WebSocket(WS_URL);

    // 等待欢迎消息
    await new Promise(resolve => {
      ws.once('message', resolve);
    });

    // 等待 ping（最多 35 秒）
    const pingMessage = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('No ping received'));
      }, 35000);

      ws.on('message', data => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'ping') {
            clearTimeout(timeout);
            resolve(msg);
          }
        } catch (e) {
          // 忽略解析错误
        }
      });
    });

    assert.equal(pingMessage.type, 'ping');
    assert.ok(pingMessage.timestamp);

    ws.close();
  });

  it('should respond to server ping with pong', async () => {
    const ws = new WebSocket(WS_URL);

    // 等待欢迎消息
    await new Promise(resolve => {
      ws.once('message', resolve);
    });

    // 发送 ping
    ws.send(JSON.stringify({ type: 'ping' }));

    // 等待 pong
    const pongMessage = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('No pong received'));
      }, 5000);

      ws.on('message', data => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'pong') {
            clearTimeout(timeout);
            resolve(msg);
          }
        } catch (e) {
          // 忽略解析错误
        }
      });
    });

    assert.equal(pongMessage.type, 'pong');
    assert.ok(pongMessage.timestamp);

    ws.close();
  });

  it('should handle connection close', async () => {
    const ws = new WebSocket(WS_URL);

    await new Promise(resolve => {
      ws.on('open', resolve);
    });

    ws.close();

    await new Promise(resolve => {
      ws.on('close', () => {
        resolve();
      });
    });
  });
});

console.log('✅ WebSocket 测试完成');
