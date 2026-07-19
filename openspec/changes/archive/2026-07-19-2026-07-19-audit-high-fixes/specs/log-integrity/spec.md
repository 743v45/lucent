## ADDED Requirements

### Requirement: 导出与导入 SHALL 限制文件路径在日志目录内，禁止路径穿越

`POST /api/logs/export` 的 `format` MUST 经白名单校验（仅允许 `jsonl` 或 `markdown`，否则 400）；导出文件名 MUST 用 `path.basename` 净化（剥离任何路径分隔符），且最终输出路径 resolve 后 MUST `startsWith` `resolveEffectiveConfig().logDir`，否则拒绝。`POST /api/logs/import` 的 `filePath` resolve 后 MUST `startsWith` 日志目录，否则 400。MUST NOT 接受任何可逃逸日志目录的相对路径片段（如 `../`）。

**Rationale:** 导出 `format` 直接拼进文件名、导入 `filePath` 直传 `readFileSync`，二者均无校验；叠加 `log-manager.ts` 的 `mkdirSync(dirname, {recursive:true})` 会主动创建穿越目标目录并 `writeFileSync` 覆盖写，构成任意文件写（配 `0.0.0.0` 时可写 `.bashrc` 等达成 RCE）；导入可读进程权限内任意文件。白名单 + 目录围栏封堵。

#### Scenario: 导出 format 含路径片段被拒绝
- **GIVEN** 一个已运行的实例
- **WHEN** POST /api/logs/export body 为 `{ "format": "jsonl/../../../foo" }`
- **THEN** MUST 返回 400（白名单拒绝）
- **AND** MUST NOT 在日志目录外创建任何文件或目录

#### Scenario: 导出文件路径被限定在日志目录内
- **GIVEN** 导出 format 合法（jsonl）
- **WHEN** 拼接出的输出路径 resolve 后落在 logDir 之外
- **THEN** MUST 拒绝（不写文件）

#### Scenario: 导入 filePath 逃逸日志目录被拒绝
- **GIVEN** 一个已运行的实例
- **WHEN** POST /api/logs/import body 为 `{ "filePath": "/etc/passwd" }` 或含 `../`
- **THEN** MUST 返回 400
- **AND** MUST NOT 读取该路径
