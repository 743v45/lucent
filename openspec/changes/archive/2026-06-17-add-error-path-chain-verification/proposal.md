## Why

现有协议链路验收脚本(verify:anthropic / openai-chat / openai-responses /
verify:custom) 只覆盖 **200 成功路径**,完全没有 4xx/5xx 错误路径的覆盖。

proxy 转发错误响应时不是直接 pipe,是走 `readBodyWithLimit` 读全文再
`res.end(errorText)`(proxy.ts:240-248)。这个特殊路径的代码从未被
自动化测试覆盖过——一旦回归,客户端收到的错误体可能被破坏,日志/UI
可能丢失 status 字段。

## What Changes

- 新增 `scripts/verify-custom-errors-e2e.mjs`:
  - 1 个 mock upstream 同时处理 3 协议错误格式
    (anthropic: `{type:'error', error:{type, message}}`;
     openai: `{error:{message, type, code}}`)
  - hxy + hxy2 临时配齐 3 协议
  - 状态码集合: 200(基线)/ 401(鉴权) / 429(限流) / 500(服务器错误)
  - 2 供应商 × 3 协议 × 4 状态码 × 5 环节 = **120 验收点**
- 新增 npm script `verify:custom-errors`
- spec 加 1 条 Requirement: 错误路径全链路验收契约

## Capabilities

### Modified Capabilities
- `protocol-chain-verification`: 加错误路径全链路验收契约

## Impact

- 受影响代码: 无
- 受影响脚本: + verify-custom-errors-e2e.mjs
- 受影响 npm scripts: + verify:custom-errors
- 不影响 runtime 行为、API、依赖

## 边界说明
- 跳过 3xx 重定向(proxy 不实现重定向跟随)
- 5xx 只测 429 + 500 两个代表(其他 502/503/504 行为同 500,可由本契约推导)
- 4xx 只测 401(其他 400/403 业务错误格式同 401,可由本契约推导)
