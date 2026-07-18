# AGENTS.md

本项目所有变更走 OpenSpec(spec-driven)。动代码前先读本文件。

## 变更流程

任何非 trivial 改动(新功能、行为变更、协议/路由调整)**MUST** 先提 change proposal:

```
openspec/changes/<YYYY-MM-DD>-<slug>/
  ├── .openspec.yaml      # schema: spec-driven
  ├── proposal.md          # Why / What Changes / Capabilities / Impact
  └── specs/<capability>/spec.md   # delta：## ADDED Requirements + SHALL/MUST + Scenario（archive 必需）
```

**关键**:要能 `openspec validate` + `archive`,change **MUST** 带 `specs/<capability>/spec.md` delta(`## ADDED Requirements`,每个 Requirement 含 SHALL/MUST + 至少一个 `#### Scenario:`),不能只写 proposal.md——否则 validate 失败、无法 archive(只写 proposal 的 change 会堆积在 changes/ 无法归档)。

提案经确认 → `openspec validate <name>` 过 → 实现 → 验证 → `openspec archive <name>` 归档到 `openspec/changes/archive/`,稳定契约落地 `openspec/specs/<capability>/spec.md`。琐碎 fix/重构可不带 delta(写 proposal 留记录即可,不 archive)。

## OpenSpec CLI

全局已装 `openspec`(spec-driven workflow 工具)。

| 命令 | 用途 |
|------|------|
| `openspec list` | 列出活跃 changes(`--specs` 列已落地 spec) |
| `openspec validate <name>` | 校验某个 change/spec(改完先跑) |
| `openspec archive <change-name>` | 实现完成 + 验证通过后归档,同步更新主 spec |
| `openspec show <name>` | 查看 change/spec 内容 |
| `openspec status <change-name>` | 查看 change 各 artifact 完成情况 |

典型一轮:`openspec validate <change>` 过 → 实现并跑测试 → `openspec archive <change>` 归档。

## 已落地契约

改动相关区域前必读:

- [`verification-workflow`](openspec/specs/verification-workflow/spec.md) — 完成声明与验证纪律
- [`provider-baseurl`](openspec/specs/provider-baseurl/spec.md) — baseUrl 含版本路径 + `/v1` 去重
- [`e2e-verification`](openspec/specs/e2e-verification/spec.md) — 端到端验收脚本契约
- [`protocol-model`](openspec/specs/protocol-model/spec.md) — 三协议身份维度单源(PROTOCOL_REGISTRY)
- [`body-rewrite`](openspec/specs/body-rewrite/spec.md) — 可选请求 body 子串重写规则引擎(fieldPath+正则+替换,默认透明)
- [`log-mode`](openspec/specs/log-mode/spec.md) — 日志记录三态(off/临时/存档)+TTL 自动清理+expires_at 区分存档/临时(改日志记录行为前必读)
