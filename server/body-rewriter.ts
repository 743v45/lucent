/**
 * Body 重写引擎
 *
 * 对请求 JSON body 的「字符串叶子值」执行子串替换（value.replace(regex, replacement)），
 * 用于在流量进入上游前脱敏/改写特定字段（典型：剥离 Anthropic billing header）。
 *
 * ==================== 语义要点 ====================
 *
 * 1. 级联（串行）：rules 数组顺序执行，操作同一**可变** jsonBody——A 的输出即 B 的输入。
 *    多条规则命中同一叶子会叠加改写。
 *
 * 2. 零命中透明：仅当 newValue !== oldValue 才计数 applied++ 并写回；零匹配不写、不计数，
 *    保持原值与原引用。applyBodyRewritesToBuffer 在 applied===0 时直接返回原 buffer 引用。
 *
 * 3. 失败回退铁律（绝不抛）：每条规则外层 try/catch，非法 pattern / 路径越界 / 类型不匹配
 *    一律 log.debug 后跳过该规则，其余规则继续；buffer 入口同样全包 try/catch。
 *
 * 4. 仅改字符串叶子：叶子值 typeof === 'string' 才替换；number/boolean/object/array 跳过。
 *
 * ⚠️ KV-Cache 副作用（opt-in 固有代价，详见 BodyRewriteRule JSDoc）：
 *    重写位于 Anthropic KV-Cache 前缀内的字段（典型 system[0].text）会使上游缓存按字节
 *    寻址失效，触发 cache 重建（cache_read 归零、重新 cache_creation）。脱敏收益与缓存
 *    代价由配置方权衡。
 */

import type { BodyRewriteRule } from './types.js';
import createDebug from 'debug';

const log = createDebug('lucent:body-rewriter');

// ==================== FieldPathError ====================

/**
 * 字段路径解析错误。空串、未闭合 `[`、非数字下标、非法首字符时抛出。
 * name 恒为 'FieldPathError'，便于上层按名归因。
 */
export class FieldPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FieldPathError';
  }
}

// ==================== 字符分类（手写 tokenizer 辅助）====================

function isIdentStart(ch: string): boolean {
  // [a-zA-Z_]
  return ('a' <= ch && ch <= 'z') || ('A' <= ch && ch <= 'Z') || ch === '_';
}

function isIdentPart(ch: string): boolean {
  // [a-zA-Z0-9_-]
  return isIdentStart(ch) || ('0' <= ch && ch <= '9') || ch === '-';
}

function isDigit(ch: string): boolean {
  return '0' <= ch && ch <= '9';
}

// ==================== parseFieldPath ====================

/**
 * 解析字段路径为 (string|number)[] token 序列。
 *
 * 语法：
 *   - IDENT:  [a-zA-Z_][a-zA-Z0-9_-]*   （对象键，允许连字符）
 *   - INDEX:  [0-9]+                     （数组下标，写作 [n]）
 *   - 分隔符 `.` 可省：a[0]b ≡ a[0].b
 *
 * 混合示例：system[0].text / messages[0].content[1].text / a[0][1]
 *
 * 错误（抛 FieldPathError）：
 *   - 空串
 *   - 未闭合的 `[`
 *   - 非数字下标（如 a[x]）
 *   - 非法首字符（必须以 IDENT 起始字符或 `[` 开头）
 *
 * 不使用 split('.'): 无法正确处理 `[n]` 段与连字符键。
 *
 * @param path 字段路径字符串
 * @returns token 序列，string=对象键，number=数组下标
 */
export function parseFieldPath(path: string): (string | number)[] {
  if (path.length === 0) {
    throw new FieldPathError('字段路径为空');
  }

  const tokens: (string | number)[] = [];
  const n = path.length;
  let i = 0;

  while (i < n) {
    const ch = path[i];

    // 分隔符 '.'：跳过（可省，故仅消费）
    if (ch === '.') {
      i++;
      continue;
    }

    // 数组下标 [n]
    if (ch === '[') {
      i++; // 消费 '['
      let num = '';
      while (i < n && path[i] !== ']') {
        num += path[i];
        i++;
      }
      // 未闭合
      if (i >= n) {
        throw new FieldPathError(`未闭合的 '[': ${path}`);
      }
      // 到达 ']'；下标必须是非空纯数字
      if (num.length === 0 || !num.split('').every(isDigit)) {
        throw new FieldPathError(`非法数组下标 '[${num}]': ${path}`);
      }
      tokens.push(Number(num));
      i++; // 消费 ']'
      continue;
    }

    // 对象键 IDENT
    if (isIdentStart(ch)) {
      let ident = '';
      while (i < n && isIdentPart(path[i])) {
        ident += path[i];
        i++;
      }
      tokens.push(ident);
      continue;
    }

    // 非法字符（含以数字开头的非法首字符，如 0a）
    throw new FieldPathError(`非法字符 '${ch}' 于路径: ${path}`);
  }

  // 全为分隔符的退化情形（如 "."）→ 无 token，视为非法
  if (tokens.length === 0) {
    throw new FieldPathError(`路径无有效 token: ${path}`);
  }

  return tokens;
}

// ==================== getNestedValue ====================

export interface LocateResult {
  /** 路径是否解析到已存在的位置（缺键 / 越界 / 类型不匹配 → false） */
  found: boolean;
  /** 定位到的值；found=false 时为 undefined */
  value: unknown;
}

/**
 * 按 token 序列逐层定位值（只读）。
 *
 * 规则：
 *   - number token：当前值须为 Array 且下标在界内；
 *   - string token：当前值须为非 null、非 Array 的 object 且键存在（`in` 判定，区分「值为 undefined」与「键不存在」）；
 *   - 中途遇 null/undefined、类型与 token 不匹配、缺键、越界 → found:false。
 *
 * @param obj 根对象
 * @param tokens parseFieldPath 产出的 token 序列
 */
export function getNestedValue(obj: unknown, tokens: (string | number)[]): LocateResult {
  if (obj === null || obj === undefined) {
    return { found: false, value: undefined };
  }

  let current: unknown = obj;
  for (const token of tokens) {
    if (typeof token === 'number') {
      // 下标访问：须为数组、在界内、且为整数
      if (!Array.isArray(current) || token < 0 || token >= current.length || !Number.isInteger(token)) {
        return { found: false, value: undefined };
      }
      current = current[token];
    } else {
      // 键访问：须为非 null、非数组的 object，且键存在
      if (typeof current !== 'object' || current === null || Array.isArray(current)) {
        return { found: false, value: undefined };
      }
      const rec = current as Record<string, unknown>;
      if (!(token in rec)) {
        return { found: false, value: undefined };
      }
      current = rec[token];
    }
  }

  return { found: true, value: current };
}

// ==================== 定位父容器 + 末位 key（写回前置）====================

interface ParentAndKey {
  /** 叶子的父容器（object 或 array） */
  parent: object;
  /** 末位 token：string=对象键，number=数组下标 */
  key: string | number;
}

/**
 * 解析出可写回的 (父容器, 末位 key)。
 *
 * 要写回叶子必须拿到父容器引用 + 末位 key：
 *   - tokens 长度 1：父容器 = jsonBody 本身，末位 = tokens[0]；
 *   - tokens 长度 >1：用 getNestedValue 走 tokens.slice(0,-1) 得父容器（须 found 且为 object/array），末位 = 末 token。
 *
 * 末位与父容器类型须匹配且目标存在：
 *   - 末位 number → 父须为 Array 且下标在界内；
 *   - 末位 string → 父须为非 null、非数组的 object 且键存在。
 *
 * 任一条件不满足 → 返回 null（静默跳过）。
 */
function locateParentAndKey(jsonBody: unknown, tokens: (string | number)[]): ParentAndKey | null {
  const lastToken = tokens[tokens.length - 1];
  if (lastToken === undefined) {
    return null;
  }

  // 父容器解析
  let parent: unknown;
  if (tokens.length === 1) {
    parent = jsonBody;
  } else {
    const located = getNestedValue(jsonBody, tokens.slice(0, -1));
    if (!located.found) {
      return null;
    }
    parent = located.value;
  }

  if (typeof parent !== 'object' || parent === null) {
    return null;
  }

  // 末位与父容器类型校验 + 存在性
  if (typeof lastToken === 'number') {
    const arr = parent as unknown[];
    if (!Array.isArray(arr) || lastToken < 0 || lastToken >= arr.length) {
      return null;
    }
    return { parent, key: lastToken };
  }

  const rec = parent as Record<string, unknown>;
  if (Array.isArray(parent) || !(lastToken in rec)) {
    return null;
  }
  return { parent, key: lastToken };
}

/** 从父容器读取叶子当前值。 */
function readLeaf(parent: object, key: string | number): unknown {
  if (typeof key === 'number') {
    return (parent as unknown[])[key];
  }
  return (parent as Record<string, unknown>)[key];
}

/** 将新值写回父容器。 */
function writeLeaf(parent: object, key: string | number, value: unknown): void {
  if (typeof key === 'number') {
    (parent as unknown[])[key] = value;
  } else {
    (parent as Record<string, unknown>)[key] = value;
  }
}

// ==================== applyBodyRewrites ====================

export interface RewriteOutcome {
  /** 改写后的 body（与入参同一可变引用） */
  body: unknown;
  /** 实际发生替换的次数（零匹配 / 跳过不计） */
  applied: number;
}

/**
 * 对 JSON body 顺序应用重写规则（级联，操作同一可变 body）。
 *
 * 执行流程（每条规则）：
 *   1. enabled === false → 跳过（enabled 缺省 = true）；
 *   2. 整条规则外层 try/catch——解析/正则/定位任一异常 → log.debug 后 continue（绝不抛）；
 *   3. parseFieldPath + locateParentAndKey 定位叶子；定位失败 → 跳过；
 *   4. 仅当叶子值 typeof === 'string' 才执行 value.replace(new RegExp(pattern, flags ?? 'g'), replacement)；
 *   5. newValue !== oldValue 才写回父容器并 applied++（零匹配不计数、不写）。
 *
 * 父容器类型与末位 token 不匹配（如末位是 number 但父是 object）→ 定位失败 → 跳过。
 *
 * @param jsonBody 已解析的请求体（会被就地修改）
 * @param rules 重写规则数组
 */
export function applyBodyRewrites(jsonBody: unknown, rules: BodyRewriteRule[]): RewriteOutcome {
  let applied = 0;

  for (const rule of rules) {
    // enabled 缺省视为 true；显式 false 跳过
    if (rule.enabled === false) {
      continue;
    }

    try {
      const tokens = parseFieldPath(rule.fieldPath);
      const located = locateParentAndKey(jsonBody, tokens);
      if (located === null) {
        continue;
      }

      const { parent, key } = located;
      const oldValue = readLeaf(parent, key);

      // 仅字符串叶子才替换
      if (typeof oldValue !== 'string') {
        continue;
      }

      const newValue = oldValue.replace(
        new RegExp(rule.pattern, rule.flags ?? 'g'),
        rule.replacement,
      );

      // 零匹配（值未变）→ 不写、不计数
      if (newValue !== oldValue) {
        writeLeaf(parent, key, newValue);
        applied++;
      }
    } catch (e) {
      // 注：debug 包返回的是直接可调用函数（见 kvcache.ts / agent-identifier.ts），无 .debug 方法
      log('规则跳过 id=%s err=%s', rule.id, (e as Error).message);
      continue;
    }
  }

  return { body: jsonBody, applied };
}

// ==================== applyBodyRewritesToBuffer ====================

/**
 * Buffer 入口：在 JSON content-type 上应用重写，否则原样返回。
 *
 * 失败回退铁律（保透明）——以下情况一律返回**原 buffer 引用**且 applied=0：
 *   1. 无启用规则（!rules.some(r => r.enabled !== false)）；
 *   2. buf.length === 0；
 *   3. contentType 不含 'application/json'（大小写不敏感）；
 *   4. JSON.parse 失败（非法 JSON 字节）；
 *   5. 解析成功但零命中（applied===0）——避免无谓的序列化往返。
 *
 * 命中时返回 Buffer.from(JSON.stringify(json), 'utf8')（紧凑格式，无缩进空白）。
 *
 * @param buf 原始请求 body 字节
 * @param rules 重写规则数组
 * @param contentType 请求 Content-Type 头
 */
export function applyBodyRewritesToBuffer(
  buf: Buffer,
  rules: BodyRewriteRule[],
  contentType: string,
): { buffer: Buffer; applied: number } {
  // 无启用规则 → 原引用
  if (!rules.some((r) => r.enabled !== false)) {
    return { buffer: buf, applied: 0 };
  }
  // 空 buffer → 原引用
  if (buf.length === 0) {
    return { buffer: buf, applied: 0 };
  }
  // 非 JSON → 原引用
  if (!contentType.toLowerCase().includes('application/json')) {
    return { buffer: buf, applied: 0 };
  }

  try {
    const json = JSON.parse(buf.toString('utf8'));
    const { applied } = applyBodyRewrites(json, rules);

    // 零命中 → 原引用（保透明，不做无谓序列化往返）
    if (applied === 0) {
      return { buffer: buf, applied: 0 };
    }

    return { buffer: Buffer.from(JSON.stringify(json), 'utf8'), applied };
  } catch (e) {
    log('buffer 重写失败，返回原 buffer err=%s', (e as Error).message);
    return { buffer: buf, applied: 0 };
  }
}
