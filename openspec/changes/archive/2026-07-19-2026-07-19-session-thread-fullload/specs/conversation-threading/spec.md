# conversation-threading Specification Delta

## ADDED Requirements

### Requirement: sub 请求按时间邻近落 threadId

对每个请求，`buildRequestEntry`（server/interceptor.ts）MUST 按 agentType 决定 threadId 落库方式：`agentType === 'main'` 用 `globalSessionTracker.identify(body, url, timestamp)` 算内容寻址 threadId（首条 user 哈希，语义不变）；`agentType !== 'main'`（sub：cc_is_subagent / specialist / teammate）MUST 调 `globalSessionTracker.findRecentThread(timestamp)` 落"lastTimestamp ≤ 该 sub timestamp 的最近一个 main lineage 的 threadId"，无匹配则 threadId 为 undefined。

`SessionTracker` MUST 暴露 `findRecentThread(atOrBeforeISO: string): string | undefined`，扫描内存 `sessions`（anchorKey → lineages[]）的全部 lineage，返回 `lastTimestamp ≤ atOrBeforeISO` 中 lastTimestamp 最大的那个 threadId。该判定基于运行期内存状态，重启即丢——sub 在 lineage 重建前暂无 threadId，待下次同会话 main 请求 identify 重建 lineage 后恢复。

sub 的 threadId 继承自父 main 的内容寻址 id（非 sub 自身内容寻址），因为 sub 的 body 是独立子任务 prompt，无父对话 messages 前缀、无父引用字段，无法靠内容寻址或显式父 id 关联。

**Rationale:** 原设计（2026-06-13）把 sub 归属列为 YAGNI 非目标，靠前端 groupByThread 对"已加载分页 logs"做时间邻近附属——但 useLogs 只加载 50/页、软上限 500，单个会话残缺。把附属判定搬到后端 interceptor（对进程内全量活跃 lineage 判定，不受分页限制）并落库 thread_id，使按 threadId 全量查询成为可能。时序保证：main 响应流回 → 主代理解析 tool_call 派生 sub → sub 请求，故 main 的 identify 几乎必先于 sub 的 buildRequestEntry。语义与前端旧逻辑等价（时间邻近非血缘，多 main 并行时可能附错——前端现状亦然），但精度更高。

#### Scenario: sub 落最近 main 的 threadId
- **GIVEN** 进程内已 identify 一个 main lineage（threadId=thread_x，lastTimestamp=T1）
- **WHEN** 一个 sub 请求在 T2(>T1) 到达，buildRequestEntry 调 findRecentThread(T2)
- **THEN** 该 sub entry 的 threadId MUST 为 thread_x
- **AND** 写入 logs.thread_id = thread_x

#### Scenario: 无最近 main → sub threadId 为 undefined
- **GIVEN** 进程刚启动 / lineage 被 LRU 清理 / 首个请求就是 sub
- **WHEN** 一个 sub 请求到达，findRecentThread 返回 undefined
- **THEN** 该 sub entry 的 threadId MUST 为 undefined

#### Scenario: sub 时间戳早于所有 main lineage → undefined
- **GIVEN** 进程内 main lineage 的 lastTimestamp 均 > sub.timestamp
- **WHEN** sub 请求调 findRecentThread(sub.timestamp)
- **THEN** 返回 undefined，sub threadId 为 undefined

#### Scenario: 多个候选取 lastTimestamp 最大者
- **GIVEN** 进程内两个 main lineage：thread_a(lastTimestamp=T1)、thread_b(lastTimestamp=T2>T1)
- **WHEN** sub 在 T3(>T2) 调 findRecentThread(T3)
- **THEN** 返回 thread_b（lastTimestamp 最大且 ≤ T3）

### Requirement: 按 threadId 全量查询日志

`GET /api/logs` MUST 接受 `threadId` query param，透传到 `LogsQuery.threadId` → `readLogs` filter → `listLogs`/`searchLogs` 的 `ListFilter.threadId` → `applyFilter` 生成 `WHERE thread_id = ?`（命中部分索引 idx_logs_thread）。带 threadId 的查询 MUST 返回该会话已落 thread_id 的全部 main+sub 行，不受会话视图的 `PAGE_SIZE`/`LOGS_SOFT_CAP` 可见范围限制（单会话全量），但仍受 readLogs 的 `MAX_LOG_QUERY_LIMIT` 单页上限约束（超大会话用 cursor 续页）。不带 threadId 的查询行为不变（全量按时间分页）。threadId 过滤 MUST 可与 agentType/providerName/endpointType/search 等其他 filter 叠加。

**Rationale:** 会话视图的"组内全量"依赖后端按 threadId 一把拉全该会话的 main+sub。thread_id 列与 idx_logs_thread 索引建表时已有，本次只是接通 ListFilter/applyFilter/LogsQuery/路由/前端 api 的过滤维度。复用 /api/logs 不新建端点。

#### Scenario: 带 threadId 返回该会话全部行
- **GIVEN** 库内 thread_id=thread_x 的行有 10 条（main+sub），thread_id=thread_y 的 5 条
- **WHEN** GET /api/logs?threadId=thread_x
- **THEN** 返回 10 条（均 thread_id=thread_x），不含 thread_y
- **AND** total=10

#### Scenario: 不带 threadId 行为不变
- **WHEN** GET /api/logs（无 threadId）
- **THEN** 按时间 DESC 分页，跨所有 thread_id，行为与改动前一致

#### Scenario: threadId 过滤可与其他 filter 叠加
- **GIVEN** thread_x 下有 anthropic + openai 两种 provider 的行
- **WHEN** GET /api/logs?threadId=thread_x&providerName=anthropic
- **THEN** 只返回 thread_x 下 provider=anthropic 的行

### Requirement: 会话视图组内全量加载

前端会话视图（SessionListView）的**会话目录**（有哪些会话、每组标题/token 汇总）仍由 `groupByThread` 对 useLogs 已加载的分页 logs 生成（main 的 threadId 内容寻址保证目录稳定）。会话组默认展开；**组内行** MUST 在展开时按 threadId 后端懒加载全量：展开触发 `GET /api/logs?threadId=<组 threadId>`，加载完成前先渲染分页凑出的部分行（保证切视图行立即可见、不丢条），加载完成后用完整 main+sub 序列替换组内渲染（覆盖分页部分，补全分页外请求）。

全量加载的组内行 MUST 走与 useLogs visibleLogs 一致的 expiresAt 过滤（已过期临时日志不渲染）。加载中的组 MUST 有 loading 占位；加载失败 MUST 回退到分页里已有的部分行并提示错误。

**Rationale:** A1 方案：目录复用现有 groupByThread（改动小、UI 不变），只把"组内行"从"分页凑出"升级为"后端全量"。老会话（所有 main 被挤出 500 软上限）在目录里看不到——这是 A1 的已知局限，用户可 loadMore 翻到；A2（目录也全量，新增 DISTINCT thread_id 聚合查询）作为后续迭代。groupByThread 的前端 sub 时间邻近附属逻辑在 sub 已落 thread_id 后收窄：sub 直接进 byThread，ungrouped 仅保留给无 thread_id 且无邻近 main 的孤立请求。

#### Scenario: 展开的组按 threadId 懒加载全量
- **GIVEN** 会话视图显示一组 thread_x（默认展开，组内先渲染分页凑出的部分行）
- **WHEN** 该组处于展开状态（首屏默认展开，或用户折叠后再展开）
- **THEN** MUST 发起 GET /api/logs?threadId=thread_x 懒加载该会话全量
- **AND** 加载完成后组内行替换为全量结果（含分页外的请求）；加载中显示分页已有行 + loading 提示

#### Scenario: 全量行过滤已过期临时日志
- **GIVEN** thread_x 全量结果含一条 expiresAt 已过期的临时行
- **WHEN** 组内渲染
- **THEN** 该过期行 MUST 不渲染（与时间线视图一致）

#### Scenario: 目录仍由分页 logs 生成
- **GIVEN** useLogs 已加载 50 条（含 thread_x、thread_y 各若干 main）
- **WHEN** 会话视图渲染目录
- **THEN** 目录列出 thread_x、thread_y（基于已加载 logs 的 threadId）
- **AND** 即便某会话实际有更多请求在分页外，目录仍显示该会话（点开后全量加载补全组内行）

#### Scenario: 加载失败回退分页已有行
- **GIVEN** 用户展开 thread_x 组，触发全量加载
- **WHEN** 该请求失败
- **THEN** 组内 MUST 回退到分页里已有的部分行
- **AND** MUST 有错误提示
