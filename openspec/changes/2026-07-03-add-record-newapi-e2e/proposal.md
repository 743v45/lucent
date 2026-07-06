## Why

`scripts/record-newapi-e2e.ts`（`npm run record:newapi`）是这次 Lucent × new-api
真实链路录屏落地的产物，定位是「测试标准种子」——可复用的共享契约，不是一次性
脚本。它和 `e2e-verification`（`verify-e2e.mjs`）互补但**不是一类东西**：

- `e2e-verification` 打的是 **mock 上游 + 路径转发**（`/v1` 去重、preset/custom
  转发、test-connection 拼接），上游返回什么它不关心，因为 fixture 是自己塞的。
- `record-newapi-e2e` 打的是 **真实 reasoning 模型上游 + 实际回答内容**：穿过
  Lucent 代理打真请求、录屏、并断言模型真的回了内容。

把后者塞进前者会把「mock 路径转发」和「真实内容验收」两套语义搅在一起，所以
单独立一条 capability。

更重要的是，本次踩的坑必须沉淀成 spec：reasoning 模型（这里的
`openai/unsloth/Qwen3.6-27B-MTP-GGUF`）在 `max_tokens` 给小了时，会把预算全花在
思考上——`finish_reason=length`、`content` 空串，**HTTP 照样 200、body 是非空
JSON 壳子**。如果 e2e 验收只看 `status===200 && body 非空`，这种「空答」会被当
成通过，正好漏过本 issue 背景专门点名的故障模式。写进 spec，下次打 reasoning
模型的 e2e 验收就不会再漏。

## What Changes

- 把已有的 `scripts/record-newapi-e2e.ts` + `npm run record:newapi` 登记为受 openspec
  管控的契约（脚本本身已实现并实跑通过，本 change 只补 spec 登记，不改脚本逻辑）。
- 登记四件事：
  1. **脚本存在与运行**：`scripts/record-newapi-e2e.ts` + `npm run record:newapi`，
     客户端 base URL 指 Lucent 代理（不是直连 new-api），覆盖 openai-chat 与
     openai-responses 各自的流式 + 非流式，Playwright 录 `.webm`，退出码 0=绿/非 0=红。
  2. **隔离**：临时 config dir（`mkdtempSync`）+ 随机高位端口，`LUCENT_CONFIG_DIR`
     指向临时目录，绝不碰 `~/.lucent/config.json`。
  3. **key 只从 env 读、不落盘**：`process.env.OPENAI_API_KEY`，缺了快速失败（退出
     非 0）；脚本里不出现明文 key、不写进 config、不 commit；Lucent 后端进程 env
     主动剔掉 `OPENAI_API_KEY`（透明代理用不上，key 只活在驱动侧 fetch 的
     `Authorization` header 里）。
  4. **内容断言规则（最该落地的结晶）**：打 reasoning 模型的 e2e 验收 MUST 断言
     实际回答内容，不能只看 `200 + body 非空`。具体：chat 非流式看
     `choices[0].message.content` 非空 且 `finish_reason !== 'length'`；responses
     非流式看 `output_text` 非空；流式看 `frames>0` 且至少一帧 content delta（不是
     只有 reasoning）。断言驱动退出码，空答/截断必须退出非 0。

## Capabilities

### New Capabilities
- `record-newapi-e2e`：真实 reasoning 上游的 e2e 录屏脚本的存在/运行/隔离/key 注入，
  以及「必须断言实际回答内容、不只看 200+body 非空」的内容断言规则。
  （与 `e2e-verification` 互补：那条管 mock 路径转发，这条管真实内容验收。）

### Modified Capabilities
无。

## Impact

- 受影响代码：无（脚本已实现，本 change 只补 openspec 登记，不改 `scripts/`、
  `server/`、`src/`、`tests/` 任何逻辑）。
- 受影响 npm scripts：无新增（`record:newapi` 此前已在 PR 中加入 `package.json`）。
- 受影响文档：新增一条 capability spec（archive 后落到
  `openspec/specs/record-newapi-e2e/spec.md`）。
- 不影响 runtime 行为、API、依赖。
- 适用场景：任何打真实 reasoning 模型上游的 e2e 验收/录屏，以及任何「只看 HTTP 状态
  码会漏掉空答」的验收场景。
