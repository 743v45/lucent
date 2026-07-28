# Docker 加固与部署 — 设计文档

**日期**: 2026-07-28
**主题**: 为 Lucent 加固现有 Docker 配置并完成本地部署，端口对外暴露

## 背景与现状

Lucent 是 AI Agent 透明代理。单 Node 进程同时提供两个服务：

- **代理端口 7048** — 透明穿透转发到上游 API（Anthropic / OpenAI 等）
- **Web UI 端口 7049** — Express 托管构建好的 React 前端 + REST/SSE API

仓库已存在 Docker 支持（commit `347be31`，后 `630b0b7` 改 alpine 构建）：`Dockerfile`（多阶段：builder 构建前端、runner 装 prod 依赖 + `tsx` 直跑后端 TS）、`docker-compose.yml`（暴露 7048/7049、命名卷 `lucent-data`→`/data`、`init:true`、`restart:unless-stopped`）、`.dockerignore`。

**结论**：端口"暴露出来"和基本可部署性已具备；本设计聚焦**生产加固**，然后在本机实际部署并验证。

### 关键正确性确认

`server/constants.ts` 中 `CONFIG_DIR = process.env.LUCENT_CONFIG_DIR || ~/.lucent`，因此设 `LUCENT_CONFIG_DIR=/data` 后：

- `config.json` → `/data/config.json`
- `LOG_DIR` → `/data/logs`
- `DB_PATH` → `/data/lucent.db`（better-sqlite3）

**所有可写状态全部落在 `/data` volume 内**。这是非 root 运行与 `read_only` 根文件系统可行的前提——应用无其他可写路径需求（已知）。

### 运行环境

Docker Desktop 29.6.2 + Compose v5.3.1，架构 aarch64（Apple Silicon）。`docker compose` 由 Docker Desktop 提供插件。

## 目标

1. 加固镜像与运行时：非 root、最小权限、健康检查、配置外部化。
2. 在本机 `docker compose up` 跑起来，7048/7049 对外可访问并验证健康。
3. 不改变应用功能行为（纯 infra 改动，不动协议/路由/日志逻辑）。

## 非目标

- 不引入多容器拓扑（无 nginx/redis，单容器即可）。
- 不做镜像签名 / 私有 registry 推送。
- 不改后端代码（仅在确认 `/api/health` 已满足后复用，无需新增端点）。

## 设计

### 1. Dockerfile（仅改 runner 阶段）

- **非 root 运行**：`node:20-alpine` 自带 `node` 用户（uid 1000）。新增：
  ```dockerfile
  RUN mkdir -p /data && chown -R node:node /data
  USER node
  ```
  命名卷首次挂载时 Docker 从镜像内 `/data` 复制并保留属主 → 非 root 进程可写 `/data`。builder 阶段不动。
- **HEALTHCHECK**：复用既有 `GET /api/health`（返回 `200 {status:'ok'}`）：
  ```dockerfile
  HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget -qO- http://127.0.0.1:7049/api/health || exit 1
  ```
  alpine 自带 busybox `wget`，无需额外安装。容器内端口固定 7049，`start-period` 给 tsx 冷启 + 原生模块加载留缓冲。

### 2. docker-compose.yml

- `security_opt: ["no-new-privileges:true"]` — 提权防护，零成本。
- `read_only: true` + `tmpfs: ["/tmp"]` — 根文件系统只读，仅 `/data`（卷）与 `/tmp`（tmpfs）可写。**部署时实测**：若 tsx/better-sqlite3 运行时有未预见的可写路径导致崩溃或健康检查不转 healthy，则回退移除这两行（保留其余加固）。
- 宿主机侧端口改由 `.env` 覆盖：`ports` 写 `"${LUCENT_PROXY_PORT:-7048}:7048"` / `"${LUCENT_WEB_PORT:-7049}:7049"`——compose 只把 `.env` 用于 `${VAR}` 替换、**不注入容器环境**，故无陷阱；容器内固定 7048/7049，healthcheck/EXPOSE 不受影响。
- 日志旋钮（`LUCENT_LOG_MODE` / `LUCENT_LOG_RETENTION_DAYS` / `LUCENT_TEMP_LOG_TTL_MINUTES`）**不自动透传**：这些变量一旦存在（哪怕空串）app 即视为 env 锁定（`logModeEnvOverridden`/`envLocked`=true，UI 控件禁用）。故保持 compose `environment` 内注释态，仅用户显式启用时注入。`LUCENT_HOST`/`LUCENT_CONFIG_DIR` 硬编码。
- 端口 host 侧默认 `0.0.0.0`（全网可访，便于外部接入）；`.env` 未设时映射 `7048:7048` / `7049:7049`。

### 3. 新增 / 补充文件

- **`.env.example`**（新）：文档化全部可调旋钮（`LUCENT_LOG_MODE` / `LUCENT_LOG_RETENTION_DAYS` / `LUCENT_TEMP_LOG_TTL_MINUTES`）+ 注释说明改 host 端口、host 绑定网卡的方法。
- **`.gitignore`** 与 **`.dockerignore`**：加入 `.env`（避免本地覆盖或敏感配置进入镜像/仓库）。
- **README.md**：末尾新增「Docker 部署」小节（构建/启动/端口/持久化/常用命令）。

## 环境变量契约（容器内）

| 变量 | 作用域 | 来源 | 说明 |
|------|--------|------|------|
| `LUCENT_HOST` | 容器环境 | 硬编码 `0.0.0.0`（compose） | 必须监听所有网卡才能被端口映射到达 |
| `LUCENT_CONFIG_DIR` | 容器环境 | 硬编码 `/data`（compose） | 持久化根（config.json + logs/ + lucent.db） |
| `LUCENT_PROXY_PORT` / `LUCENT_WEB_PORT` | compose 替换（不进容器） | `.env` 可选，`${VAR:-7048/7049}` | 宿主机侧发布端口；未设=7048/7049 |
| `LUCENT_LOG_MODE` | 容器环境（注入即锁定） | compose `environment` 注释态 | off / temporary / archive；默认 archive |
| `LUCENT_LOG_RETENTION_DAYS` | 容器环境（注入即锁定） | compose `environment` 注释态 | 存档保留期；默认 3 |
| `LUCENT_TEMP_LOG_TTL_MINUTES` | 容器环境（注入即锁定） | compose `environment` 注释态 | 临时日志存活分钟；默认 30 |

> 关键约束：`LUCENT_LOG_MODE` 等三个日志旋钮**一旦出现在容器环境（哪怕空串）即触发 env 锁定**（`logModeEnvOverridden`/`envLocked`=true，UI 控件禁用），故 compose 默认不注入、仅在用户取消注释时启用。`LUCENT_PROXY_PORT`/`LUCENT_WEB_PORT` 仅用于 compose `${VAR}` 替换宿主侧端口，不进容器环境，无此约束。

> 供应商配置（含 API Key）存于 `/data/config.json`，通过 Web UI 管理，不进环境变量。

## 部署与验证

1. `docker compose build` — 验证 better-sqlite3 在 arm64/musl 源码编译通过（关键风险点）。
2. `docker compose up -d` — 后台启动。
3. `curl -s http://localhost:7049/api/health` → 期望 `{"status":"ok",...}`（Web UI 端口可达）。
4. 探测代理端口 7048 在监听（未配供应商时返回 404 属正常，只验证端口活着）。
5. `docker compose ps` → STATUS 列出现 `healthy`（HEALTHCHECK 生效）。
6. `read_only` 实测：观察容器未因只读文件系统崩溃、健康检查转 healthy；否则回退并记录原因。

## 安全考量

- 代理端口 7048 绑定 `0.0.0.0`：同局域网设备可借此走用户配置的供应商（消耗其 API Key）。默认按用户要求全网可访；如需收紧，改 compose `ports` 为 `127.0.0.1:7048:7048`（`.env.example` 注释说明）。
- 非 root + `no-new-privileges` + `read_only`：降低容器逃逸/提权后的影响面。
- API Key 不进镜像、不进环境变量，仅在 `/data` 卷内（host 侧卷数据仍需按需保护）。

## 范围外 / 后续可选

- 镜像版本/digest 精确固定（当前 `node:20-alpine` 标签可接受）。
- 资源限额（`mem_limit` / `cpus`）。
- 自定义 bridge 网络（单容器无收益）。
- CI 构建推送镜像到 registry。

## 与项目 OpenSpec 约定的关系

本次为 infra/部署加固，不改协议、路由、日志等功能行为，按 `AGENTS.md`「琐碎 fix/重构可不带 delta」处理，不新建 OpenSpec change proposal。
