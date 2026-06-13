# 使用说明改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 `UsageGuide` 弹窗的接入地址错误（`/api/` → 正确前缀），把折叠面板改为按客户端分组的单页平铺，统一品牌名 Lucent，README 同步对齐。

**Architecture:**
- 把"生成接入指令"的逻辑从 `UsageGuide.tsx` 抽成纯函数 `buildAccessLines(host, port, providers)`，方便单测验证地址正确性这个核心不变量。
- `UsageGuide.tsx` 改造为：标题 + 一句介绍 + 三条规则提示 + 按客户端分组的指令列表 + 无供应商时的"去配置"按钮。
- `App.tsx` 透传 `onOpenSettings={() => setSettingsOpen(true)}` 给弹窗。
- `README.md` 使用方法章节区分预设/自定义并加 OpenAI `/v1` 提示。

**Tech Stack:** React 19 + TypeScript + Tailwind v4 + antd v6 + Vitest (node 环境，不引入 jsdom)

---

## File Structure

| 文件 | 改动 |
|-----|------|
| `src/components/common/UsageGuide.tsx` | 重构（抽纯函数 + 新排版 + 新文案 + 新 prop） |
| `src/App.tsx` | 透传 `onOpenSettings` prop |
| `README.md` | 使用方法章节 |
| `tests/usage-guide.test.ts` | 新建（纯函数单测） |

不引入新依赖。不改 `src/types.ts`、`src/constants.ts`、SettingsModal、其他前端组件、server 代码。

---

### Task 1: 抽 `buildAccessLines` 纯函数 + 写失败单测

**Files:**
- Create: `tests/usage-guide.test.ts`
- Modify: `src/components/common/UsageGuide.tsx:1-80`

- [ ] **Step 1: 写失败单测（断言 `/api/` 不再生成 + 三个规则全对）**

创建 `tests/usage-guide.test.ts`：

```ts
/**
 * UsageGuide 接入指令生成纯函数单测
 *
 * 核心不变量：弹窗里展示的 Base URL 必须与 server 实际行为一致
 * - 预设供应商: http://{host}:{port}/{name}
 * - 自定义供应商: http://{host}:{port}/custom/{name}
 * - OpenAI 端点: 末尾加 /v1
 *
 * 运行: npx vitest run tests/usage-guide.test.ts
 */

import { describe, it, expect } from 'vitest';
import { buildAccessLines, type AccessLineInput } from '../src/components/common/UsageGuide';

function preset(name: string, endpoints: Record<string, string> = {}) {
  return { name, presetName: name, endpoints };
}
function custom(name: string, endpoints: Record<string, string> = {}) {
  return { name, presetName: null as unknown as string, endpoints };
}

const HOST = '127.0.0.1';
const PORT = 7048;

describe('buildAccessLines', () => {
  it('预设供应商生成的 Base URL 不含 /api/ 也不含 /custom/', () => {
    const lines = buildAccessLines(HOST, PORT, [
      preset('anthropic', { 'anthropic-messages': 'https://api.anthropic.com' }),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0].cmd).toBe('export ANTHROPIC_BASE_URL=http://127.0.0.1:7048/anthropic');
    expect(lines[0].cmd).not.toContain('/api/');
    expect(lines[0].cmd).not.toContain('/custom/');
  });

  it('自定义供应商生成的 Base URL 含 /custom/', () => {
    const lines = buildAccessLines(HOST, PORT, [
      custom('my-glm', { 'anthropic-messages': 'https://open.bigmodel.cn/api/coding/paas/v4' }),
    ]);
    expect(lines[0].cmd).toBe('export ANTHROPIC_BASE_URL=http://127.0.0.1:7048/custom/my-glm');
  });

  it('OpenAI 端点 (openai-chat) 末尾加 /v1', () => {
    const lines = buildAccessLines(HOST, PORT, [
      preset('openai', { 'openai-chat': 'https://api.openai.com' }),
    ]);
    expect(lines[0].cmd).toBe('export OPENAI_BASE_URL=http://127.0.0.1:7048/openai/v1');
  });

  it('OpenAI Responses 端点末尾也加 /v1', () => {
    const lines = buildAccessLines(HOST, PORT, [
      preset('openai', { 'openai-responses': 'https://api.openai.com' }),
    ]);
    expect(lines[0].cmd).toBe('export OPENAI_BASE_URL=http://127.0.0.1:7048/openai/v1');
  });

  it('按 clientName 分组：anthropic → Claude Code，openai-* → Codex / OpenAI', () => {
    const lines = buildAccessLines(HOST, PORT, [
      preset('a', { 'anthropic-messages': 'x' }),
      preset('b', { 'openai-chat': 'y' }),
      preset('c', { 'openai-responses': 'z' }),
    ]);
    expect(lines.find(l => l.providerName === 'a')?.clientName).toBe('Claude Code');
    expect(lines.find(l => l.providerName === 'b')?.clientName).toBe('Codex / OpenAI');
    expect(lines.find(l => l.providerName === 'c')?.clientName).toBe('Codex / OpenAI');
  });

  it('同一供应商多端点：anthropic + openai 各生成一行', () => {
    const lines = buildAccessLines(HOST, PORT, [
      preset('hybrid', { 'anthropic-messages': 'x', 'openai-chat': 'y' }),
    ]);
    expect(lines).toHaveLength(2);
    expect(lines.map(l => l.cmd).sort()).toEqual([
      'export ANTHROPIC_BASE_URL=http://127.0.0.1:7048/hybrid',
      'export OPENAI_BASE_URL=http://127.0.0.1:7048/hybrid/v1',
    ]);
  });

  it('空 providers 数组返回空数组', () => {
    expect(buildAccessLines(HOST, PORT, [])).toEqual([]);
  });

  it('端点 URL 为空的端点不生成指令', () => {
    const lines = buildAccessLines(HOST, PORT, [
      preset('p', { 'anthropic-messages': '', 'openai-chat': 'y' }),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0].endpointType).toBe('openai-chat');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/usage-guide.test.ts 2>&1 | tail -20`
Expected: FAIL with "Cannot find module" 或 "buildAccessLines is not a function"

- [ ] **Step 3: 在 `UsageGuide.tsx` 中抽出纯函数 + 导出**

修改 `src/components/common/UsageGuide.tsx`：

把第 13-76 行的常量定义 + `useEffect` 内部逻辑里的 `accessLines` 生成移出来，替换为纯函数并 `export`：

```ts
/** 端点类型对应的接入环境变量名 */
const ENV_VAR_FOR_ENDPOINT: Record<EndpointType, string> = {
  'anthropic-messages': 'ANTHROPIC_BASE_URL',
  'openai-chat': 'OPENAI_BASE_URL',
  'openai-responses': 'OPENAI_BASE_URL',
};

/** 端点类型对应的接入客户端名称 */
const CLIENT_NAME_FOR_ENDPOINT: Record<EndpointType, string> = {
  'anthropic-messages': 'Claude Code',
  'openai-chat': 'Codex / OpenAI',
  'openai-responses': 'Codex / OpenAI',
};

/** OpenAI 端点需要额外加 /v1 后缀 */
const NEEDS_V1_SUFFIX: Set<EndpointType> = new Set(['openai-chat', 'openai-responses']);

export interface AccessLine {
  providerName: string;
  endpointType: EndpointType;
  clientName: string;
  cmd: string;
  upstreamUrl: string;
}

export interface AccessLineInput {
  name: string;
  presetName: string | null;
  endpoints: Partial<Record<EndpointType, string>>;
}

/**
 * 生成接入指令列表（纯函数，便于单测）
 *
 * 接入地址规则（与 server 路由一致，见 server/index.ts:108 + proxy.ts:34）:
 * - 预设供应商 (presetName !== null/undefined): http://{host}:{port}/{name}
 * - 自定义供应商 (presetName 为空): http://{host}:{port}/custom/{name}
 * - OpenAI 端点: 末尾加 /v1
 */
export function buildAccessLines(
  host: string,
  port: number,
  providers: AccessLineInput[],
): AccessLine[] {
  const lines: AccessLine[] = [];
  for (const provider of providers) {
    const endpointTypes = Object.keys(provider.endpoints) as EndpointType[];
    for (const endpointType of endpointTypes) {
      const endpointUrl = provider.endpoints[endpointType];
      if (!endpointUrl) continue;
      const envVar = ENV_VAR_FOR_ENDPOINT[endpointType];
      const suffix = NEEDS_V1_SUFFIX.has(endpointType) ? '/v1' : '';
      const prefix = provider.presetName ? '' : 'custom/';
      const cmd = `export ${envVar}=http://${host}:${port}/${prefix}${provider.name}${suffix}`;
      lines.push({
        providerName: provider.name,
        endpointType,
        clientName: CLIENT_NAME_FOR_ENDPOINT[endpointType],
        cmd,
        upstreamUrl: endpointUrl,
      });
    }
  }
  return lines;
}
```

同时**删除**原文件第 13-28 行的三段 const 常量定义（已上移到顶部）。把原 63-76 行的 `accessLines` 构造逻辑（组件函数内部）**改为调用 `buildAccessLines(host, proxyPort, providers)`**。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/usage-guide.test.ts 2>&1 | tail -15`
Expected: 8 个 test 全部 PASS

- [ ] **Step 5: 跑全量单测确认没破坏其他测试**

Run: `npx vitest run 2>&1 | tail -10`
Expected: 全部测试通过（之前通过的还通过）

- [ ] **Step 6: 提交**

```bash
git add tests/usage-guide.test.ts src/components/common/UsageGuide.tsx
git commit -m "refactor(usage-guide): 抽 buildAccessLines 纯函数 + 接入地址规则单测覆盖"
```

---

### Task 2: 弹窗去掉折叠面板 + 按客户端分组的单页平铺

**Files:**
- Modify: `src/components/common/UsageGuide.tsx:78-150`

- [ ] **Step 1: 手动验证现状（基线截图）**

```bash
npm run dev
```
浏览器开 `http://localhost:5173`，点顶栏"使用说明"按钮，看到折叠面板。手动记录目前宽度（`width={520}`）。

- [ ] **Step 2: 替换弹窗主体 JSX**

把 `src/components/common/UsageGuide.tsx` 的 `return` 函数体（78-150 行）**整段替换**为：

```tsx
return (
  <Modal
    open={open}
    onCancel={onClose}
    title="使用说明"
    width={560}
    footer={null}
  >
    <div className="flex flex-col gap-4">
      {/* 文案两段 */}
      <div className="flex flex-col gap-2">
        <p className="text-[14px] text-text-secondary leading-relaxed">
          Lucent 是 AI API 代理。在「配置」中添加供应商，设置环境变量将客户端请求指向本代理即可。
        </p>
        <p className="text-[14px] text-text-secondary leading-relaxed">
          预设供应商无前缀；自定义供应商加 <code className="font-mono text-text-primary bg-bg-input px-1.5 py-0.5 rounded text-[13px]">custom/</code>；OpenAI 端点需加 <code className="font-mono text-text-primary bg-bg-input px-1.5 py-0.5 rounded text-[13px]">/v1</code> 后缀。
        </p>
      </div>

      {/* 按客户端分组 */}
      {accessLines.length > 0 && (
        <div className="flex flex-col gap-5">
          {(['Claude Code', 'Codex / OpenAI'] as const).map((groupName) => {
            const groupLines = accessLines.filter(l => l.clientName === groupName);
            if (groupLines.length === 0) return null;
            return (
              <div key={groupName} className="flex flex-col gap-2">
                <h3 className="text-[14px] font-[560] text-text-primary m-0">{groupName}</h3>
                <div className="flex flex-col gap-2">
                  {groupLines.map((line, index) => (
                    <div key={`${line.providerName}-${line.endpointType}`} className="flex flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <code className="flex-1 text-[13px] px-2 py-1.5 rounded bg-bg-deep text-text-primary font-mono break-all">
                          {line.cmd}
                        </code>
                        <Button
                          type="text"
                          size="small"
                          icon={copiedIndex === index ? <CheckOutlined /> : <CopyOutlined />}
                          onClick={() => handleCopy(line.cmd, index)}
                          className={copiedIndex === index ? '!text-success' : '!text-text-quaternary hover:!text-text-primary'}
                        />
                      </div>
                      <div className="flex items-center gap-2 pl-1">
                        <span className="text-[12px] text-text-quaternary shrink-0">供应商 {line.providerName} → 上游</span>
                        <code className="text-[12px] text-text-tertiary font-mono truncate" title={line.upstreamUrl}>
                          {line.upstreamUrl}
                        </code>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {accessLines.length === 0 && (
        <div className="flex flex-col gap-3">
          <div className="text-[14px] text-text-quaternary">暂无配置的供应商。请先在「配置」中添加供应商。</div>
          {onOpenSettings && (
            <div>
              <Button type="primary" size="small" onClick={handleOpenSettings}>去配置</Button>
            </div>
          )}
        </div>
      )}
    </div>
  </Modal>
);
```

- [ ] **Step 3: 删除不再用的 import**

在 `import` 段（第 1-6 行）删除：
- `import { Collapse } from 'antd';`（如果存在）
- `import type { Provider, EndpointType } from '../../types';` 中的 `Provider`（不再需要 Provider 类型，用 AccessLineInput 替代）

实际需要先看文件当前 import 是什么。改之前 Read 一下，然后精准 Edit。

- [ ] **Step 4: 跑单测确认没破坏**

Run: `npx vitest run tests/usage-guide.test.ts 2>&1 | tail -10`
Expected: 8 tests still PASS

- [ ] **Step 5: 手动验证 UI**

```bash
npm run dev
```
浏览器开：
1. 配 1 个预设 anthropic + 1 个自定义 my + 1 个 openai-responses 端点
2. 点"使用说明"
3. 验证：单页平铺、无折叠、按 Claude Code / Codex / OpenAI 分组、每行是完整 `export ...`、有复制按钮、有上游 URL
4. 验证：删除所有供应商时，显示文案 + 「去配置」按钮

- [ ] **Step 6: 提交**

```bash
git add src/components/common/UsageGuide.tsx
git commit -m "refactor(usage-guide): 单页平铺 + 按客户端分组 + 品牌 Lucent"
```

---

### Task 3: 弹窗接 `onOpenSettings` 回调 + App 透传

**Files:**
- Modify: `src/components/common/UsageGuide.tsx:8-12, 30-50`
- Modify: `src/App.tsx:34, 188, 230`

- [ ] **Step 1: 给 UsageGuide 加 `onOpenSettings` prop + handler**

修改 `src/components/common/UsageGuide.tsx`：

接口（第 8-11 行）改为：

```ts
interface UsageGuideProps {
  open: boolean;
  onClose: () => void;
  onOpenSettings?: () => void;
}
```

组件函数解构（第 30 行）改为：

```ts
export function UsageGuide({ open, onClose, onOpenSettings }: UsageGuideProps) {
```

在 `handleCopy` 函数下面加一个 handler：

```ts
const handleOpenSettings = () => {
  onClose();
  onOpenSettings?.();
};
```

- [ ] **Step 2: App.tsx 透传回调**

修改 `src/App.tsx`：

找到 `<UsageGuide ... />` 的渲染位置（**当前 App.tsx:230 附近**，先 Read 确认行号），在 props 里加 `onOpenSettings`：

```tsx
<UsageGuide
  open={usageGuideOpen}
  onClose={() => setUsageGuideOpen(false)}
  onOpenSettings={() => setSettingsOpen(true)}
/>
```

（具体行号以当前 `App.tsx` 实际位置为准，先 Read 定位。）

- [ ] **Step 3: 手动验证「去配置」流程**

```bash
npm run dev
```
1. 确保无供应商（或临时清空）
2. 打开使用说明 → 看到「去配置」按钮
3. 点击 → 弹窗关闭，SettingsModal 打开
4. 在 SettingsModal 加一个供应商保存 → 关闭
5. 再开使用说明 → 应有指令列表

- [ ] **Step 4: 跑全量单测**

Run: `npx vitest run 2>&1 | tail -5`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/components/common/UsageGuide.tsx src/App.tsx
git commit -m "feat(usage-guide): 无供应商时「去配置」按钮 + App 透传回调"
```

---

### Task 4: README 改造

**Files:**
- Modify: `README.md:55-96`

- [ ] **Step 1: Read 现状 README 的「使用方法」三段**

```bash
sed -n '55,96p' README.md
```

- [ ] **Step 2: 改写「使用方法」章节**

把 `README.md:55-96`（快速开始后到 CLI 命令前的整段）替换为：

```markdown
## 使用方法

Lucent 工作在客户端和上游 API 之间 —— 客户端把 Base URL 指向本代理即可。

### 1. 添加供应商

打开 Web UI (`http://127.0.0.1:7049`)，点顶栏 **配置**，加一个供应商：

- **预设供应商**（如 GLM / Anthropic）：下拉选预设名即可
- **自定义供应商**：自己取名 + 填上游 Base URL（如 `https://open.bigmodel.cn/api/coding/paas/v4`）

### 2. 接入下游客户端

在客户端设置环境变量，把请求指向本代理。**Base URL 规则**：

| 供应商类型 | Base URL |
|-----------|---------|
| 预设供应商 | `http://127.0.0.1:7048/{供应商名}` |
| 自定义供应商 | `http://127.0.0.1:7048/custom/{供应商名}` |
| OpenAI 端点 | 上述规则末尾 + `/v1` |

> 应用内的 **使用说明** 弹窗会根据你配置的供应商自动生成可复制的 `export` 命令。
```

- [ ] **Step 3: 全文 grep 确认没残留错误示例**

```bash
grep -n "/api/{供应商名}\|/api/glm\|/api/openai" README.md
```
Expected: 无输出

```bash
grep -n "AgentProxy" README.md
```
Expected: 无输出（README 现状应该是 Lucent）

- [ ] **Step 4: 提交**

```bash
git add README.md
git commit -m "docs(readme): 使用方法区分预设/自定义供应商 + OpenAI /v1 提示"
```

---

### Task 5: 端到端验证（手动 + 自动化 e2e）

**Files:**
- Create: `tests/usage-guide-e2e.test.ts`（可选，但建议）

- [ ] **Step 1: 启动 backend + 前端 dev**

```bash
# 终端 1
npm run dev

# 终端 2
npm run build  # 验证生产构建无 TS 错误
```

- [ ] **Step 2: 写一个端到端 e2e（可选但建议）**

创建 `tests/usage-guide-e2e.test.ts`：

```ts
/**
 * UsageGuide 端到端验证：弹窗生成的地址在 server 端真实可用
 *
 * 启动一个测试 backend，配 1 个自定义供应商 + 1 个 OpenAI 端点，
 * 抓取 /api/status 拿到 providers，再调用 buildAccessLines 生成命令，
 * 把生成出的 URL 直接打到 server 上，断言能被路由（而不是 404）。
 *
 * 运行: npx vitest run tests/usage-guide-e2e.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAccessLines } from '../src/components/common/UsageGuide';
import { createTestEnv, cleanTestDir, startBackend, stopBackend, writeTestConfig, type TestEnv } from './e2e-helpers.js';
import { createServer, type Server } from 'node:http';

const env: TestEnv = createTestEnv('usage-guide-e2e');
let backend: { kill: () => void } | null = null;
let mockUpstream: Server | null = null;
let upstreamReceived: string[] = [];

describe('UsageGuide 生成地址真实可用', () => {
  beforeAll(async () => {
    await cleanTestDir(env);
    upstreamReceived = [];
    // mock 上游：所有路径都返回 200
    mockUpstream = createServer((req, res) => {
      upstreamReceived.push(req.url || '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
    await new Promise<void>(r => mockUpstream!.listen(0, r));
    const upstreamPort = (mockUpstream.address() as { port: number }).port;

    await writeTestConfig(env, {
      providers: [
        {
          name: 'my-test',
          presetName: null,
          endpoints: {
            'anthropic-messages': `http://127.0.0.1:${upstreamPort}`,
          },
        },
        {
          name: 'openai',
          presetName: 'openai',
          endpoints: {
            'openai-chat': `http://127.0.0.1:${upstreamPort}`,
          },
        },
      ],
    });
    backend = await startBackend(env);
  }, 30_000);

  afterAll(async () => {
    if (backend) await stopBackend(backend);
    if (mockUpstream) await new Promise<void>(r => mockUpstream!.close(() => r()));
  });

  it('自定义供应商生成的地址 /custom/my-test/v1/messages 能被路由到 mock 上游', async () => {
    const lines = buildAccessLines('127.0.0.1', env.proxyPort, [
      { name: 'my-test', presetName: null, endpoints: { 'anthropic-messages': 'http://127.0.0.1:1' } },
    ]);
    const baseUrl = lines[0].cmd.match(/=(.+)$/)![1];
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'test', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'x', messages: [], max_tokens: 1 }),
    });
    expect(res.status).toBe(200);
    expect(upstreamReceived.some(p => p.includes('/v1/messages'))).toBe(true);
  });

  it('OpenAI 端点生成的地址 /openai/v1/chat/completions 能被路由', async () => {
    const lines = buildAccessLines('127.0.0.1', env.proxyPort, [
      { name: 'openai', presetName: 'openai', endpoints: { 'openai-chat': 'http://127.0.0.1:1' } },
    ]);
    const baseUrl = lines[0].cmd.match(/=(.+)$/)![1];
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer test' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    expect(res.status).toBe(200);
    expect(upstreamReceived.some(p => p.includes('/chat/completions'))).toBe(true);
  });
});
```

- [ ] **Step 3: 跑 e2e**

Run: `npx vitest run tests/usage-guide-e2e.test.ts 2>&1 | tail -20`
Expected: 2 tests PASS

- [ ] **Step 4: 跑全量测试**

Run: `npx vitest run 2>&1 | tail -10`
Expected: 全部 PASS（不破坏现有）

- [ ] **Step 5: 手动在浏览器里复制弹窗里的命令，真跑一次**

```bash
npm run dev
```
1. 配 1 个自定义供应商（URL 随便填个能通的）
2. 打开使用说明 → 复制 export 命令
3. 在 shell 里 `eval` 那条 export
4. 用 curl 触发一次请求：`curl -X POST $ANTHROPIC_BASE_URL/v1/messages ...`
5. 在 Web UI 日志面板看到这条请求 → 通过

- [ ] **Step 6: 提交**

```bash
git add tests/usage-guide-e2e.test.ts
git commit -m "test(usage-guide): 端到端验证生成的 Base URL 在 server 端真实可路由"
```

---

## Self-Review Checklist

- [x] **Spec 覆盖：**
  - §1 三处病灶 → Task 1（接入地址）、Task 2（单页平铺 + Lucent 品牌）、Task 4（README）
  - §3 接入地址规则 → Task 1 纯函数强制实现规则
  - §4.1-4.2 移除/文案 → Task 2
  - §4.3 排版 → Task 2
  - §4.4 无供应商 + 去配置 → Task 3
  - §5 README 改造 → Task 4
  - §7 验收标准 → Task 5
- [x] **Placeholder 扫描：** 无 TBD/TODO，所有代码块完整
- [x] **类型一致性：** `buildAccessLines` / `AccessLine` / `AccessLineInput` 在 Task 1 定义，Task 2 + Task 5 引用一致
- [x] **依赖未引入新包**
- [x] **范围未越界：** 不动 DetailPanel/App/KV-Cache/响应式/token
