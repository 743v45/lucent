/**
 * Body 重写引擎单元测试（仅引擎部分）
 *
 * 覆盖：parseFieldPath / getNestedValue / applyBodyRewrites / applyBodyRewritesToBuffer
 * 注意：validateBodyRewrites 的测试由 config 主线负责，此处不涉及，避免冲突。
 */

import { describe, it, expect } from 'vitest';
import {
  parseFieldPath,
  getNestedValue,
  applyBodyRewrites,
  applyBodyRewritesToBuffer,
  FieldPathError,
} from '../server/body-rewriter.js';
import type { BodyRewriteRule } from '../server/types.js';

// ==================== parseFieldPath ====================

describe('parseFieldPath', () => {
  it('对象键 + 数组下标混合：system[0].text', () => {
    expect(parseFieldPath('system[0].text')).toEqual(['system', 0, 'text']);
  });

  it('多层混合：messages[0].content[1].text', () => {
    expect(parseFieldPath('messages[0].content[1].text')).toEqual([
      'messages', 0, 'content', 1, 'text',
    ]);
  });

  it('纯点分对象键：a.b.c', () => {
    expect(parseFieldPath('a.b.c')).toEqual(['a', 'b', 'c']);
  });

  it('单段：system', () => {
    expect(parseFieldPath('system')).toEqual(['system']);
  });

  it('连续下标：a[0][1]', () => {
    expect(parseFieldPath('a[0][1]')).toEqual(['a', 0, 1]);
  });

  it('分隔符可省：a[0]b ≡ a[0].b', () => {
    expect(parseFieldPath('a[0]b')).toEqual(['a', 0, 'b']);
  });

  it('连字符键：x-foo[0]', () => {
    expect(parseFieldPath('x-foo[0]')).toEqual(['x-foo', 0]);
  });

  it('空串抛 FieldPathError', () => {
    expect(() => parseFieldPath('')).toThrow(FieldPathError);
  });

  it('未闭合 [ 抛 FieldPathError：a[0', () => {
    expect(() => parseFieldPath('a[0')).toThrow(FieldPathError);
  });

  it('非数字下标抛 FieldPathError：a[x]', () => {
    expect(() => parseFieldPath('a[x]')).toThrow(FieldPathError);
  });

  it('非法首字符抛 FieldPathError：0a', () => {
    expect(() => parseFieldPath('0a')).toThrow(FieldPathError);
  });

  it('抛出的错误 name 为 FieldPathError', () => {
    try {
      parseFieldPath('');
    } catch (e) {
      expect((e as Error).name).toBe('FieldPathError');
    }
  });
});

// ==================== getNestedValue ====================

describe('getNestedValue', () => {
  it('正常嵌套 + 数组定位 found:true', () => {
    const obj = { system: [{ type: 'text', text: 'hello' }] };
    const r = getNestedValue(obj, ['system', 0, 'text']);
    expect(r.found).toBe(true);
    expect(r.value).toBe('hello');
  });

  it('数组越界 found:false', () => {
    const obj = { messages: [{ role: 'user' }] };
    const r = getNestedValue(obj, ['messages', 99, 'content']);
    expect(r.found).toBe(false);
  });

  it('中间值是 string 却用 number token found:false', () => {
    const obj = { a: 'hello' };
    const r = getNestedValue(obj, ['a', 0]);
    expect(r.found).toBe(false);
  });

  it('中间值是 array 却用 string token found:false', () => {
    const obj = { a: [1, 2, 3] };
    const r = getNestedValue(obj, ['a', 'b']);
    expect(r.found).toBe(false);
  });

  it('缺键 found:false', () => {
    const obj = { a: { b: { c: 1 } } };
    const r = getNestedValue(obj, ['a', 'b', 'missing']);
    expect(r.found).toBe(false);
  });

  it('null 输入 found:false', () => {
    expect(getNestedValue(null, ['a']).found).toBe(false);
  });

  it('undefined 输入 found:false', () => {
    expect(getNestedValue(undefined, ['a']).found).toBe(false);
  });

  it('中间遇到 null found:false', () => {
    const obj = { a: { b: null } };
    const r = getNestedValue(obj, ['a', 'b', 'c']);
    expect(r.found).toBe(false);
  });
});

// ==================== applyBodyRewrites ====================

describe('applyBodyRewrites', () => {
  it('子串替换保留未匹配尾部（g 全局，仅删除首个 ;-delimited 段）', () => {
    // [^;]* 排除分号，故 pattern 仅匹配到第一个 `;` 为止，
    // 删除 "x-anthropic-billing-header: cc_version=2.1;" 后尾部保留。
    const body = {
      system: [{
        type: 'text',
        text: 'x-anthropic-billing-header: cc_version=2.1; cc_entrypoint=cli; You are...',
      }],
    };
    const rules: BodyRewriteRule[] = [{
      id: 'r1',
      fieldPath: 'system[0].text',
      pattern: 'x-anthropic-billing-header:[^;]*;',
      replacement: '',
    }];
    const { body: out, applied } = applyBodyRewrites(body, rules);
    expect((out as { system: Array<{ text: string }> }).system[0].text)
      .toBe(' cc_entrypoint=cli; You are...');
    expect(applied).toBe(1);
  });

  it('system 为顶层 string（fieldPath="system"）命中', () => {
    const body = { system: 'hello world', messages: [] };
    const rules: BodyRewriteRule[] = [{
      id: 'r', fieldPath: 'system', pattern: 'hello', replacement: 'hi',
    }];
    const { body: out, applied } = applyBodyRewrites(body, rules);
    expect((out as { system: string }).system).toBe('hi world');
    expect(applied).toBe(1);
  });

  it('system 为数组但 fieldPath="system"（顶层）→ 叶子非 string 跳过 applied=0', () => {
    const body = { system: [{ type: 'text', text: 'hello' }] };
    const rules: BodyRewriteRule[] = [{
      id: 'r', fieldPath: 'system', pattern: 'hello', replacement: 'hi',
    }];
    const { body: out, applied } = applyBodyRewrites(body, rules);
    expect(applied).toBe(0);
    expect((out as { system: unknown[] }).system).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('多规则顺序串行级联（A 输出是 B 输入，操作同一可变 body）', () => {
    const body = { msg: 'foo' };
    const rules: BodyRewriteRule[] = [
      { id: 'a', fieldPath: 'msg', pattern: 'foo', replacement: 'bar' },
      { id: 'b', fieldPath: 'msg', pattern: 'bar', replacement: 'baz' },
    ];
    const { body: out, applied } = applyBodyRewrites(body, rules);
    expect((out as { msg: string }).msg).toBe('baz');
    expect(applied).toBe(2);
  });

  it('flags 缺省按 g：pattern "a" 全局替换 "a a a" 三处全替 applied=1', () => {
    const body = { s: 'a a a' };
    const rules: BodyRewriteRule[] = [{
      id: 'r', fieldPath: 's', pattern: 'a', replacement: 'X',
    }];
    const { body: out, applied } = applyBodyRewrites(body, rules);
    expect((out as { s: string }).s).toBe('X X X');
    expect(applied).toBe(1);
  });

  it('flags 空串：只替换首个匹配', () => {
    const body = { s: 'a a a' };
    const rules: BodyRewriteRule[] = [{
      id: 'r', fieldPath: 's', pattern: 'a', flags: '', replacement: 'X',
    }];
    const { body: out, applied } = applyBodyRewrites(body, rules);
    expect((out as { s: string }).s).toBe('X a a');
    expect(applied).toBe(1);
  });

  it('flags="gi" + pattern "A"：大小写不敏感全局全替（API 为 flags ?? "g"，故需显式 gi 才全替）', () => {
    const body = { s: 'a A a' };
    const rules: BodyRewriteRule[] = [{
      id: 'r', fieldPath: 's', pattern: 'A', flags: 'gi', replacement: 'X',
    }];
    const { body: out, applied } = applyBodyRewrites(body, rules);
    expect((out as { s: string }).s).toBe('X X X');
    expect(applied).toBe(1);
  });

  it('非 string 值（number 42）跳过 applied=0', () => {
    const body = { n: 42 };
    const rules: BodyRewriteRule[] = [{
      id: 'r', fieldPath: 'n', pattern: '42', replacement: '',
    }];
    const { body: out, applied } = applyBodyRewrites(body, rules);
    expect(applied).toBe(0);
    expect((out as { n: number }).n).toBe(42);
  });

  it('零匹配（值是 string 但 regex 不匹配）applied=0 值不变', () => {
    const body = { s: 'hello' };
    const rules: BodyRewriteRule[] = [{
      id: 'r', fieldPath: 's', pattern: 'xyz', replacement: 'Y',
    }];
    const { body: out, applied } = applyBodyRewrites(body, rules);
    expect(applied).toBe(0);
    expect((out as { s: string }).s).toBe('hello');
  });

  it('enabled=false 跳过', () => {
    const body = { s: 'foo' };
    const rules: BodyRewriteRule[] = [{
      id: 'r', fieldPath: 's', pattern: 'foo', replacement: 'bar', enabled: false,
    }];
    const { body: out, applied } = applyBodyRewrites(body, rules);
    expect(applied).toBe(0);
    expect((out as { s: string }).s).toBe('foo');
  });

  it('数组越界 messages[99] 静默跳过 applied=0 不抛', () => {
    const body = { messages: [{ role: 'user', content: 'hi' }] };
    const rules: BodyRewriteRule[] = [{
      id: 'r', fieldPath: 'messages[99].content', pattern: 'hi', replacement: 'ho',
    }];
    const { applied } = applyBodyRewrites(body, rules);
    expect(applied).toBe(0);
  });

  it('运行期非法 pattern → 跳过该规则不抛，其他规则继续', () => {
    const body = { a: 'foo', b: 'bar' };
    const rules: BodyRewriteRule[] = [
      { id: 'bad', fieldPath: 'a', pattern: '(unclosed', replacement: '' },
      { id: 'good', fieldPath: 'b', pattern: 'bar', replacement: 'baz' },
    ];
    const { body: out, applied } = applyBodyRewrites(body, rules);
    expect(applied).toBe(1);
    expect((out as { a: string; b: string }).a).toBe('foo');
    expect((out as { a: string; b: string }).b).toBe('baz');
  });

  it('$1 反向引用生效：pattern (cc_version)= replacement $1-redacted=', () => {
    const body = { s: 'cc_version=2.1' };
    const rules: BodyRewriteRule[] = [{
      id: 'r', fieldPath: 's', pattern: '(cc_version)=', replacement: '$1-redacted=',
    }];
    const { body: out, applied } = applyBodyRewrites(body, rules);
    expect((out as { s: string }).s).toBe('cc_version-redacted=2.1');
    expect(applied).toBe(1);
  });
});

// ==================== applyBodyRewritesToBuffer ====================

describe('applyBodyRewritesToBuffer', () => {
  it('application/json + 命中 → 新 buffer，字段已脱敏，applied>0', () => {
    const buf = Buffer.from(JSON.stringify({ secret: 'password123' }), 'utf8');
    const rules: BodyRewriteRule[] = [{
      id: 'r', fieldPath: 'secret', pattern: 'password', replacement: 'REDACTED',
    }];
    const result = applyBodyRewritesToBuffer(buf, rules, 'application/json');
    expect(result.applied).toBeGreaterThan(0);
    expect(result.buffer).not.toBe(buf); // 新引用
    const parsed = JSON.parse(result.buffer.toString('utf8'));
    expect(parsed.secret).toBe('REDACTED123');
  });

  it('content-type 为 text/event-stream → 返回原 buffer 引用 applied=0', () => {
    const buf = Buffer.from(JSON.stringify({ s: 'foo' }), 'utf8');
    const rules: BodyRewriteRule[] = [{
      id: 'r', fieldPath: 's', pattern: 'foo', replacement: 'bar',
    }];
    const result = applyBodyRewritesToBuffer(buf, rules, 'text/event-stream');
    expect(result.buffer).toBe(buf);
    expect(result.applied).toBe(0);
  });

  it('content-type 为空串 → 返回原 buffer 引用 applied=0', () => {
    const buf = Buffer.from(JSON.stringify({ s: 'foo' }), 'utf8');
    const rules: BodyRewriteRule[] = [{
      id: 'r', fieldPath: 's', pattern: 'foo', replacement: 'bar',
    }];
    const result = applyBodyRewritesToBuffer(buf, rules, '');
    expect(result.buffer).toBe(buf);
    expect(result.applied).toBe(0);
  });

  it('buf.length===0 → 返回原 buffer 引用 applied=0', () => {
    const buf = Buffer.alloc(0);
    const rules: BodyRewriteRule[] = [{
      id: 'r', fieldPath: 's', pattern: 'foo', replacement: 'bar',
    }];
    const result = applyBodyRewritesToBuffer(buf, rules, 'application/json');
    expect(result.buffer).toBe(buf);
    expect(result.applied).toBe(0);
  });

  it('无启用规则 → 返回原 buffer 引用 applied=0', () => {
    const buf = Buffer.from(JSON.stringify({ s: 'foo' }), 'utf8');
    const rules: BodyRewriteRule[] = [
      { id: 'r', fieldPath: 's', pattern: 'foo', replacement: 'bar', enabled: false },
    ];
    const result = applyBodyRewritesToBuffer(buf, rules, 'application/json');
    expect(result.buffer).toBe(buf);
    expect(result.applied).toBe(0);
  });

  it('零命中 → 返回原 buffer 引用 applied=0（保透明）', () => {
    const buf = Buffer.from(JSON.stringify({ s: 'hello' }), 'utf8');
    const rules: BodyRewriteRule[] = [{
      id: 'r', fieldPath: 's', pattern: 'nomatch', replacement: 'x',
    }];
    const result = applyBodyRewritesToBuffer(buf, rules, 'application/json');
    expect(result.buffer).toBe(buf);
    expect(result.applied).toBe(0);
  });

  it('非法 JSON 字节 → 返回原 buffer applied=0 不抛', () => {
    const buf = Buffer.from('not valid json{{{', 'utf8');
    const rules: BodyRewriteRule[] = [{
      id: 'r', fieldPath: 's', pattern: 'foo', replacement: 'bar',
    }];
    const result = applyBodyRewritesToBuffer(buf, rules, 'application/json');
    expect(result.buffer).toBe(buf);
    expect(result.applied).toBe(0);
  });

  it('命中后输出是 JSON.stringify 紧凑格式（不含缩进/换行空白）', () => {
    const buf = Buffer.from(JSON.stringify({ secret: 'password' }), 'utf8');
    const rules: BodyRewriteRule[] = [{
      id: 'r', fieldPath: 'secret', pattern: 'password', replacement: 'REDACTED',
    }];
    const result = applyBodyRewritesToBuffer(buf, rules, 'application/json');
    const out = result.buffer.toString('utf8');
    expect(out).not.toContain('\n');
    expect(out).not.toContain('  '); // 无双空格缩进
    expect(out).toBe(JSON.stringify({ secret: 'REDACTED' }));
  });
});
