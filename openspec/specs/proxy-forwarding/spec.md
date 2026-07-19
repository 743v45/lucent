# proxy-forwarding Specification

## Purpose
TBD - created by archiving change 2026-07-19-audit-high-fixes. Update Purpose after archive.
## Requirements
### Requirement: 上游转发请求 SHALL 受超时与取消控制

代理对每次上游 `fetch` MUST 关联一个 `AbortController`：MUST 设置上游响应头到达超时（防止上游 stall 时客户端连接无限悬挂）；进入流式响应后 MUST 设置 idle 超时（长时间无新数据则终止）。当客户端在响应头到达前断开（`res.on('close')`）时，MUST `controller.abort()` 取消尚未完成的上游 fetch。超时或取消发生后 MUST 向客户端返回适当状态（504 超时）或安全收尾，MUST NOT 让上游连接继续空跑。

**Rationale:** 无 AbortController 时，上游 TTFT 极慢或连接 stall 会让客户端连接无限挂起（主链路 pipeline 不会因上游无数据自中断）；客户端断开后上游 fetch 仍跑完全程，按 token 计费的上游配额被空烧。响应头 / idle 超时 + 断开传播取消是转发层的资源护栏。

#### Scenario: 上游响应头超时
- **GIVEN** 一个转发请求已发出上游 fetch
- **WHEN** 上游在超时时限内未返回响应头
- **THEN** MUST abort 上游 fetch
- **AND** 向客户端返回 504

#### Scenario: 客户端断开取消未完成的上游请求
- **GIVEN** 上游 fetch 已发出、响应头尚未到达
- **WHEN** 客户端连接关闭（res close）
- **THEN** MUST abort 上游 fetch（不继续等待响应头）
- **AND** 上游连接 MUST NOT 继续跑完全程

#### Scenario: 流式 idle 超时
- **GIVEN** 已进入流式响应透传
- **WHEN** 上游在 idle 时限内未推送任何新数据
- **THEN** MUST 终止转发并安全收尾

