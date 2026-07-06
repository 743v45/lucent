/**
 * validateBodyRewrites（server/config.ts）单元测试
 *
 * 与 tests/body-rewriter.test.ts（引擎本体）分文件，避免与 engine-impl agent 冲突。
 */
import { describe, it, expect } from 'vitest';
import { validateBodyRewrites } from '../server/config.js';
import type { BodyRewriteRule } from '../server/types.js';

/** 构造一条合法规则，用 overrides 局部覆盖 */
const validRule = (overrides: Partial<BodyRewriteRule> & Record<string, unknown> = {}): BodyRewriteRule => ({
  id: 'r1',
  fieldPath: 'system[0].text',
  pattern: 'x-anthropic-billing-header:[^;]*;',
  replacement: '',
  ...overrides,
});

describe('validateBodyRewrites', () => {
  it('合法规则数组不抛', () => {
    expect(() => validateBodyRewrites([validRule()])).not.toThrow();
    expect(() => validateBodyRewrites([validRule(), validRule({ id: 'r2' })])).not.toThrow();
  });

  it('空数组不抛', () => {
    expect(() => validateBodyRewrites([])).not.toThrow();
  });

  it('非 array 抛', () => {
    expect(() => validateBodyRewrites({})).toThrow(/bodyRewrites must be an array/);
    expect(() => validateBodyRewrites('x')).toThrow(/bodyRewrites must be an array/);
    expect(() => validateBodyRewrites(null)).toThrow(/bodyRewrites must be an array/);
  });

  it('元素非对象抛', () => {
    expect(() => validateBodyRewrites([null])).toThrow(/bodyRewrites\[0\] is not an object/);
    expect(() => validateBodyRewrites([42])).toThrow(/bodyRewrites\[0\] is not an object/);
  });

  it('未知键抛且 message 含键名', () => {
    expect(() => validateBodyRewrites([{ ...validRule(), regex: 'x' }])).toThrow(/unknown key: regex/);
    expect(() => validateBodyRewrites([{ ...validRule(), fieldpath: 'x' }])).toThrow(/unknown key: fieldpath/);
  });

  it('id 缺失或空串抛', () => {
    const { id: _omit, ...rest } = validRule();
    expect(() => validateBodyRewrites([rest])).toThrow(/\.id must be a non-empty string/);
    expect(() => validateBodyRewrites([validRule({ id: '' })])).toThrow(/\.id must be a non-empty string/);
  });

  it('fieldPath 缺失或空串抛', () => {
    const { fieldPath: _omit, ...rest } = validRule();
    expect(() => validateBodyRewrites([rest])).toThrow(/fieldPath must be a non-empty string/);
    expect(() => validateBodyRewrites([validRule({ fieldPath: '' })])).toThrow(/fieldPath must be a non-empty string/);
  });

  it('fieldPath 语法非法抛且 message 含规则 id', () => {
    expect(() => validateBodyRewrites([validRule({ fieldPath: 'system[0' })])).toThrow(/fieldPath invalid/);
    expect(() => validateBodyRewrites([validRule({ fieldPath: 'system[0' })])).toThrow(/r1/);
    expect(() => validateBodyRewrites([validRule({ fieldPath: 'a[x]' })])).toThrow(/fieldPath invalid/);
  });

  it('pattern 缺失或空串抛', () => {
    const { pattern: _omit, ...rest } = validRule();
    expect(() => validateBodyRewrites([rest])).toThrow(/pattern must be a non-empty string/);
  });

  it('pattern 非法 regex 抛且 message 含规则 id', () => {
    expect(() => validateBodyRewrites([validRule({ pattern: '[unclosed' })])).toThrow(/pattern invalid/);
    expect(() => validateBodyRewrites([validRule({ pattern: '[unclosed' })])).toThrow(/r1/);
    expect(() => validateBodyRewrites([validRule({ pattern: '(?P<name>x)' })])).toThrow(/pattern invalid/);
  });

  it('flags 含非法字符抛', () => {
    expect(() => validateBodyRewrites([validRule({ flags: 'gz' })])).toThrow(/flags must match/);
    expect(() => validateBodyRewrites([validRule({ flags: 'abc' })])).toThrow(/flags must match/);
  });

  it('flags 合法值不抛（g / 空 / i / gi / ms 等）', () => {
    for (const flags of ['g', '', 'i', 'gi', 'm', 's', 'u', 'y', 'gimsuy']) {
      expect(() => validateBodyRewrites([validRule({ flags })])).not.toThrow();
    }
  });

  it('replacement 缺失抛', () => {
    const { replacement: _omit, ...rest } = validRule();
    expect(() => validateBodyRewrites([rest])).toThrow(/replacement must be a string/);
  });

  it('replacement 允许空串', () => {
    expect(() => validateBodyRewrites([validRule({ replacement: '' })])).not.toThrow();
  });

  it('replacement 非 string 抛', () => {
    expect(() => validateBodyRewrites([validRule({ replacement: 42 })])).toThrow(/replacement must be a string/);
  });

  it('enabled 非 boolean 抛', () => {
    expect(() => validateBodyRewrites([validRule({ enabled: 'true' })])).toThrow(/enabled must be a boolean/);
  });

  it('name 非 string 抛', () => {
    expect(() => validateBodyRewrites([validRule({ name: 42 })])).toThrow(/name must be a string/);
  });

  it('错误信息带规则 id 而非索引（当 id 存在）', () => {
    expect(() => validateBodyRewrites([validRule({ id: 'my-rule', pattern: '[bad' })])).toThrow(/my-rule/);
  });

  it('完整 billing header 示例规则（与 buildDefaultConfig 一致）通过校验', () => {
    const exampleRule: BodyRewriteRule = {
      id: 'example-redact-billing-header',
      name: '示例：脱敏 billing header',
      enabled: false,
      fieldPath: 'system[0].text',
      pattern: 'x-anthropic-billing-header:[^;]*;[^;]*;?',
      replacement: '',
    };
    expect(() => validateBodyRewrites([exampleRule])).not.toThrow();
  });
});
