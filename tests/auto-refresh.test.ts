/**
 * parseRefreshInterval 纯函数单测（vitest node 环境）
 *
 * useAutoRefresh 是 React hook，node 环境不可单测，其行为靠 e2e 覆盖；
 * 仅 localStorage 解析这一纯逻辑在此单测。
 */
import { describe, it, expect } from 'vitest';
import { parseRefreshInterval, REFRESH_INTERVAL_OPTIONS } from '../src/constants.js';

describe('parseRefreshInterval', () => {
  it('合法值原样返回', () => {
    for (const o of REFRESH_INTERVAL_OPTIONS) {
      expect(parseRefreshInterval(o.value)).toBe(o.value);
    }
  });

  it('null / 空串回退默认 off', () => {
    expect(parseRefreshInterval(null)).toBe('off');
    expect(parseRefreshInterval('')).toBe('off');
  });

  it('非法值回退默认 off', () => {
    expect(parseRefreshInterval('garbage')).toBe('off');
    expect(parseRefreshInterval('3s')).toBe('off'); // 不在选项枚举里
    expect(parseRefreshInterval('OFF')).toBe('off'); // 大小写敏感
  });

  it('自定义 defaultValue 生效（合法值仍优先于默认）', () => {
    expect(parseRefreshInterval(null, '5s')).toBe('5s');
    expect(parseRefreshInterval('bad', '10s')).toBe('10s');
    expect(parseRefreshInterval('1min', '5s')).toBe('1min'); // 合法值优先
  });
});
