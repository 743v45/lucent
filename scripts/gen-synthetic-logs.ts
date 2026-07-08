/**
 * 合成日志生成器（基准用）
 *
 * 生成接近真实 Lucent 拦截器写入格式的 JSONL 语料：
 * - 扁平 RawLogEntry（与 interceptor.buildRequestEntry 落盘格式一致）
 * - 体量分档：small / medium / large / huge，模拟真实 system prompt + 多轮 messages + SSE 流
 * - 中英混排；每 N 条埋一个唯一可检索锚点（EN + 中文），供 search 基准测命中/未命中
 * - 时间跨 30 天、拆多文件（≤ 当前 reader 的 20 文件读窗）
 *
 * 用法：npx tsx scripts/gen-synthetic-logs.ts [总条数] [文件数]
 * 默认 30000 条 / 18 文件，输出到 bench/logs/（BENCH_LOG_DIR 可覆盖）
 */
import { mkdirSync, appendFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ==================== 可复现 RNG ====================
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(0xC0FFEE);
const randint = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];

// ==================== 内容池 ====================
const SYS_BASE = `You are Claude Code, Anthropic's official CLI for coding tasks. 你是一个专业的编程助手，协助用户完成代码编写、调试、重构与架构设计。
# 工具使用规范
- 优先阅读源码确认事实，不要凭记忆猜测 API 行为
- 修改前先理解上下文，保持与周围代码风格一致
- 验收必须给关键节点、执行过的数据、截图或视频证据，不要空话
# 代码风格
- 命名清晰、注释适度、不堆套话
- 错误处理要显式，不要静默吞异常
# 安全
- 不提交密钥、token 到仓库
- 危险操作前与用户确认`;

const USER_POOL = [
  '帮我分析这个项目的代码结构，特别是数据存储层',
  '这个函数在高并发下有竞态，帮我重构',
  'Add a search feature to the dashboard, support Chinese keywords',
  '为什么这个 SSE 解析在某些请求上会丢行？',
  'refactor the log reader to use an indexed store instead of full scan',
  '数据库迁移要保证幂等，按 id 跳过已存在的行',
  '写一个 trigram 分词的基准测试，对比现状的延迟和内存',
  'The retention cleanup should DELETE old rows and VACUUM periodically',
  '帮我把这块单元测试补全，覆盖 CJK 子串命中',
  'explain how the KV-Cache hit rate is computed across providers',
];

const ASST_POOL = [
  '我先读了源码确认数据流：拦截器写入的是扁平 RawLogEntry，读取时归一化成嵌套格式。',
  'The fix is to introduce an index on timestamp plus the filter columns, so list queries become O(limit) instead of O(corpus).',
  '这里的关键是不阻塞代理：写入仍走异步队列，批量提交事务，客户端返回不依赖日志落库。',
  '我造了一份接近真实的合成数据跑了基准，现状列表查询要全量解析+排序，改造后走索引。',
  'trigram 分词器对中英文都按 3 字符滑窗建索引，子串语义跟现在的 includes 一致。',
  '迁移用 INSERT OR IGNORE 按 id 幂等，重跑不会重复导入。',
];

const TOOL_DEFS = [
  { name: 'Bash', description: 'Execute a bash command and return stdout', input_schema: { type: 'object', properties: { command: { type: 'string' } } } },
  { name: 'Read', description: 'Read a file from the local filesystem', input_schema: { type: 'object', properties: { file_path: { type: 'string' } } } },
  { name: 'Edit', description: 'Perform exact string replacement in a file', input_schema: { type: 'object', properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } } } },
  { name: 'Grep', description: 'Search file contents with regex', input_schema: { type: 'object', properties: { pattern: { type: 'string' } } } },
];

const PROVIDERS = [
  { name: 'anthropic', endpoint: 'anthropic-messages', url: 'https://api.anthropic.com/v1/messages', model: 'claude-opus-4-8' },
  { name: 'openai', endpoint: 'openai-chat', url: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o' },
  { name: 'glm', endpoint: 'anthropic-messages', url: 'http://new-api:3000/v1/messages', model: 'openai/unsloth/Qwen3.6-27B-MTP-GGUF' },
];

// 把 base 文本重复到约 targetChars 字节
function expand(text: string, targetChars: number): string {
  if (text.length >= targetChars) return text.slice(0, targetChars);
  let out = text;
  while (out.length < targetChars) out += '\n\n' + text;
  return out.slice(0, targetChars);
}

// ==================== 体量档位 ====================
type Tier = 'small' | 'medium' | 'large' | 'huge';
const TIER_WEIGHTS: Array<[Tier, number]> = [
  ['small', 0.05],
  ['medium', 0.65],
  ['large', 0.25],
  ['huge', 0.05],
];
function rollTier(): Tier {
  const r = rand();
  let acc = 0;
  for (const [t, w] of TIER_WEIGHTS) { acc += w; if (r < acc) return t; }
  return 'medium';
}
const TIER_SPEC: Record<Tier, { sysKB: number; msgs: number; replyChars: number; sseLines: number; streamRate: number }> = {
  small:  { sysKB: 1,  msgs: 2,  replyChars: 200,   sseLines: 15,   streamRate: 0.5 },
  medium: { sysKB: 4,  msgs: 5,  replyChars: 1500,  sseLines: 80,   streamRate: 0.85 },
  large:  { sysKB: 12, msgs: 12, replyChars: 6000,  sseLines: 150,  streamRate: 0.9 },
  huge:   { sysKB: 30, msgs: 40, replyChars: 30000, sseLines: 800,  streamRate: 0.95 },
};

// ==================== SSE 流构造 ====================
// 严格按 lineCount 切 delta：把 replyText 均分到 lineCount 段（不足则部分段为空），
// 这样 huge 档的 SSE lines 数组才真正撑大、贴近真实长回复流。
function buildSSELines(replyText: string, lineCount: number): Array<{ event: string; data: string }> {
  const lines: Array<{ event: string; data: string }> = [];
  lines.push({ event: 'message_start', data: JSON.stringify({ type: 'message_start', message: { id: 'msg_' + Math.floor(rand() * 1e9), model: 'x', usage: { input_tokens: 1000, output_tokens: 0 } } }) });
  lines.push({ event: 'content_block_start', data: JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) });
  const chunkSize = Math.max(1, Math.ceil(replyText.length / lineCount));
  for (let i = 0; i < lineCount; i++) {
    const chunk = replyText.slice(i * chunkSize, (i + 1) * chunkSize);
    lines.push({ event: 'content_block_delta', data: JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } }) });
  }
  lines.push({ event: 'content_block_stop', data: JSON.stringify({ type: 'content_block_stop', index: 0 }) });
  lines.push({ event: 'message_delta', data: JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: Math.ceil(replyText.length / 4) } }) });
  lines.push({ event: 'message_stop', data: JSON.stringify({ type: 'message_stop' }) });
  return lines;
}

// ==================== 单条 entry ====================
let needleCounter = 0;
function buildEntry(ts: Date): any {
  const tier = rollTier();
  const spec = TIER_SPEC[tier];
  const prov = pick(PROVIDERS);
  const isStream = rand() < spec.streamRate;
  const agentType = rand() < 0.3 ? 'main' : 'sub';
  const isTest = tier === 'small' && rand() < 0.4;

  // 每 250 条埋一个唯一锚点（EN + 中文），落在 user/assistant 文本里
  let enNeedle = '';
  let cnNeedle = '';
  if (needleCounter % 250 === 0) {
    enNeedle = `BENCHNEEDLE-EN-${needleCounter}`;
    cnNeedle = `基准锚点中文-${needleCounter}`;
  }
  needleCounter++;

  const msgCount = spec.msgs;
  const messages: any[] = [];
  for (let i = 0; i < msgCount; i++) {
    const role = i % 2 === 0 ? 'user' : 'assistant';
    const text = (role === 'user' ? pick(USER_POOL) : pick(ASST_POOL))
      + (enNeedle && i === 0 ? ` ${enNeedle}` : '');
    messages.push({ role, content: [{ type: 'text', text }] });
  }

  const system = expand(SYS_BASE, spec.sysKB * 1024) + (cnNeedle ? `\n${cnNeedle}` : '');
  const replyText = expand(pick(ASST_POOL), spec.replyChars) + (cnNeedle ? ` ${cnNeedle}` : '');

  const body: any = {
    model: prov.model,
    max_tokens: tier === 'huge' ? 8192 : 4096,
    messages,
    system,
    tools: TOOL_DEFS,
    stream: isStream,
  };

  const status = rand() < 0.03 ? 429 : (rand() < 0.02 ? 500 : 200);
  let respBody: any;
  let tokenUsage: any;
  if (isStream) {
    respBody = { type: 'sse_raw', lines: buildSSELines(replyText, spec.sseLines) };
    tokenUsage = { input_tokens: randint(500, 8000), output_tokens: Math.ceil(replyText.length / 4), cache_read_tokens: randint(0, 4000), cache_creation_tokens: randint(0, 2000) };
  } else {
    respBody = {
      id: 'msg_' + Math.floor(rand() * 1e9),
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: replyText }],
      model: prov.model,
      stop_reason: 'end_turn',
      usage: { input_tokens: randint(500, 8000), output_tokens: Math.ceil(replyText.length / 4) },
    };
    tokenUsage = { input_tokens: respBody.usage.input_tokens, output_tokens: respBody.usage.output_tokens };
  }

  return {
    id: `${ts.getTime()}_${Math.floor(rand() * 1e10).toString(36)}`,
    timestamp: ts.toISOString(),
    project: '',
    url: prov.url,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': 'Bearer sk-redacted',
      'user-agent': pick(['claude-code/2.1.156', 'opencode/0.9.3', 'codex/1.0.0']),
      'anthropic-version': '2023-06-01',
    },
    body,
    response: {
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      headers: { 'content-type': isStream ? 'text/event-stream' : 'application/json' },
      body: respBody,
    },
    duration: randint(50, 30000),
    isStream,
    mainAgent: agentType === 'main',
    agentType,
    apiType: prov.endpoint,
    clientType: pick(['claude-code', 'opencode', 'codex']),
    isTest,
    providerName: prov.name,
    endpointType: prov.endpoint,
    threadId: agentType === 'main' ? `thread_${randint(0, 5000)}` : undefined,
    tokenUsage,
  };
}

// ==================== 主流程 ====================
function main() {
  const total = parseInt(process.argv[2] || '30000', 10);
  const fileCount = parseInt(process.argv[3] || '18', 10);
  const outDir = process.env.BENCH_LOG_DIR || join(process.cwd(), 'bench', 'logs');

  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  // 时间跨 30 天， newest = now
  const now = Date.now();
  const spanMs = 30 * 24 * 60 * 60 * 1000;
  const startMs = now - spanMs;

  const perFile = Math.ceil(total / fileCount);
  let generated = 0;
  let bytes = 0;
  const t0 = Date.now();

  for (let f = 0; f < fileCount && generated < total; f++) {
    // 文件名沿用 lucent_<date>_<time>.jsonl，时间单调，便于 reader 排序
    const fileTs = new Date(startMs + (spanMs * (f + 0.5)) / fileCount);
    const date = fileTs.toISOString().split('T')[0];
    const time = fileTs.toTimeString().split(' ')[0].replace(/:/g, '-');
    const path = join(outDir, `lucent_${date}_${time}.jsonl`);
    const buf: string[] = [];
    const thisFile = Math.min(perFile, total - generated);
    for (let i = 0; i < thisFile; i++) {
      // 每条时间在文件时间窗内随机
      const t = startMs + (spanMs * (f + i / thisFile)) / fileCount + randint(0, 60000);
      const entry = buildEntry(new Date(t));
      buf.push(JSON.stringify(entry));
      generated++;
    }
    const content = buf.join('\n') + '\n';
    appendFileSync(path, content);
    bytes += Buffer.byteLength(content);
  }

  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(JSON.stringify({ total: generated, files: fileCount, bytesMB: +(bytes / 1024 / 1024).toFixed(1), seconds: +sec, outDir }, null, 2));
}

main();
