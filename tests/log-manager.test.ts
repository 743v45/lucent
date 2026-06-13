/**
 * log-manager.convertToMarkdown 单元测试
 *
 * 重点：Token 字段须读取 snake_case（与数据流一致），导出值非 undefined
 */

import { describe, it, expect } from 'vitest';
import { convertToMarkdown } from '../server/log-manager.js';
import { createMockLogEntry } from './test-utils.js';

describe('convertToMarkdown — Token 字段', () => {
  it('导出真实 token 值（snake_case，非 undefined）', () => {
    const log = createMockLogEntry({
      tokenUsage: {
        input_tokens: 1200,
        output_tokens: 450,
        cache_creation_tokens: 1024,
        cache_read_tokens: 896,
      },
    });

    const md = convertToMarkdown([log], true);

    expect(md).toContain('Input: 1200');
    expect(md).toContain('Output: 450');
    expect(md).toContain('Cache Read: 896');
    expect(md).toContain('Cache Write: 1024');
    expect(md).not.toContain('undefined');
  });
});
