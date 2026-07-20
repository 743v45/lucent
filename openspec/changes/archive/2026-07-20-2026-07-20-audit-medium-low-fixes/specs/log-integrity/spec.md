## ADDED Requirements

### Requirement: config.json SHALL 原子写入

`saveConfig` MUST 以原子方式持久化 `config.json`：先写入临时文件（如 `${CONFIG_PATH}.tmp`）再 `fs.renameSync` 覆盖目标（POSIX 原子）。MUST NOT 在磁盘写入成功前把变更提交到内存缓存（`cachedConfig`）：校验 → 写盘 → 成功后才 commit 缓存，写盘失败时缓存与磁盘都保持旧值并向上抛错。CRUD（setLogMode / createProvider / updateProvider / updateBodyRewrite 等）MUST NOT 就地 mutate 由 `getConfig()` 返回的共享缓存引用而后 saveConfig，而应基于克隆构造新对象整体替换。

**Rationale:** 当前 `writeFileSync` 直接覆写（非原子：truncate + write），进程在写盘中途崩溃 / 掉电会留下半截 JSON；且 `cachedConfig = config` 先于 `writeFileSync`，一旦写盘因磁盘满 / EACCES 抛错，校验已过、缓存已被改但磁盘仍是旧值，此后 `getConfig()` 返回从未持久化的内存态，缓存与磁盘分叉。原子写 + 顺序调整消除损坏与分叉。

#### Scenario: 写盘中途崩溃不留半截 JSON
- **GIVEN** 一次 saveConfig 正在执行
- **WHEN** 进程在写盘过程中崩溃 / 掉电
- **THEN** 磁盘上的 config.json MUST 是完整的旧值或完整的新值（通过 tmp + rename 原子替换），MUST NOT 是半截损坏的 JSON

#### Scenario: 写盘失败不污染缓存
- **GIVEN** 一次 CRUD 触发 saveConfig，但写盘抛错（如磁盘满 / EACCES）
- **WHEN** saveConfig 失败
- **THEN** 内存 cachedConfig MUST 保持旧值（未被本次变更污染）
- **AND** 磁盘 config.json MUST 保持旧值
- **AND** 该错误 MUST 向上传播（路由返回 500），不静默成功
