/**
 * buildAccessUrl 共享纯函数单测（Bug #30 / #33：接入地址拼接去重 + 真实端口）
 *
 * 不变量（与 server 路由一致）:
 * - 预设供应商 (presetName 非空): http://{host}:{port}/{name}
 * - 自定义供应商 (presetName 空):  http://{host}:{port}/custom/{name}
 * - OpenAI 端点: 末尾加 /v1
 * - 不传 endpointType: 只返回基础路径（SettingsModal 的单地址展示用）
 *
 * 运行: npx vitest run tests/access-url.test.ts
 */
import { describe, it, expect } from 'vitest';
import { buildAccessUrl } from '../src/utils/access-url';

describe('buildAccessUrl', () => {
  describe('前缀（presetName → custom/）', () => {
    it('预设供应商 (presetName 非空) 路径无前缀', () => {
      expect(buildAccessUrl({ name: 'anthropic', presetName: 'anthropic', port: 7048 }))
        .toBe('http://127.0.0.1:7048/anthropic');
    });

    it('自定义供应商 (presetName 为空) 路径加 custom/ 前缀', () => {
      expect(buildAccessUrl({ name: 'my-glm', presetName: null, port: 7048 }))
        .toBe('http://127.0.0.1:7048/custom/my-glm');
    });

    it('自定义供应商 (presetName undefined) 同样加 custom/ 前缀', () => {
      expect(buildAccessUrl({ name: 'my-glm', port: 7048 }))
        .toBe('http://127.0.0.1:7048/custom/my-glm');
    });
  });

  describe('OpenAI /v1 后缀', () => {
    it('openai-chat 端点末尾加 /v1', () => {
      expect(buildAccessUrl({ name: 'openai', presetName: 'openai', endpointType: 'openai-chat', port: 7048 }))
        .toBe('http://127.0.0.1:7048/openai/v1');
    });

    it('openai-responses 端点末尾也加 /v1', () => {
      expect(buildAccessUrl({ name: 'openai', presetName: 'openai', endpointType: 'openai-responses', port: 7048 }))
        .toBe('http://127.0.0.1:7048/openai/v1');
    });

    it('anthropic-messages 端点不加 /v1', () => {
      expect(buildAccessUrl({ name: 'anthropic', presetName: 'anthropic', endpointType: 'anthropic-messages', port: 7048 }))
        .toBe('http://127.0.0.1:7048/anthropic');
    });

    it('不传 endpointType 时只返回基础路径（无 /v1）—— SettingsModal 单地址展示', () => {
      expect(buildAccessUrl({ name: 'openai', presetName: 'openai', port: 7048 }))
        .toBe('http://127.0.0.1:7048/openai');
    });
  });

  describe('host / port', () => {
    it('host 默认 127.0.0.1', () => {
      expect(buildAccessUrl({ name: 'x', presetName: 'x', port: 7048 }))
        .toContain('http://127.0.0.1:7048/');
    });

    it('支持自定义 host（如局域网 IP）', () => {
      expect(buildAccessUrl({ name: 'x', presetName: 'x', host: '192.168.1.10', port: 7048 }))
        .toBe('http://192.168.1.10:7048/x');
    });

    it('支持非默认端口（Bug #30 回归：复制出的地址必须能连上）', () => {
      expect(buildAccessUrl({ name: 'x', presetName: 'x', port: 9999 }))
        .toBe('http://127.0.0.1:9999/x');
    });
  });

  describe('组合场景（与 UsageGuide buildAccessLines 输出对齐）', () => {
    it('自定义供应商 + openai-chat → custom/ + /v1', () => {
      expect(buildAccessUrl({ name: 'my-oai', presetName: null, endpointType: 'openai-chat', port: 7048 }))
        .toBe('http://127.0.0.1:7048/custom/my-oai/v1');
    });

    it('完整 export 拼接与 server banner 一致', () => {
      const url = buildAccessUrl({ name: 'openai', presetName: 'openai', endpointType: 'openai-chat', host: '127.0.0.1', port: 7048 });
      expect(`export OPENAI_BASE_URL=${url}`)
        .toBe('export OPENAI_BASE_URL=http://127.0.0.1:7048/openai/v1');
    });
  });
});
