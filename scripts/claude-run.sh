#!/usr/bin/env bash
set -euo pipefail

# ──────────────────────────────────────────────────────────────────
# claude-run.sh — 通过 AgentProxy (7048) 调用 Claude CLI
# ──────────────────────────────────────────────────────────────────
#
# 用途：给 AgentProxy 项目本身做测试，请求经代理转发并记录到日志，
#       可在 Web UI (7049) 上查看完整的请求/响应数据。
#
# 用法：
#   # 非交互（最常用）
#   PROMPT="帮我 review server/proxy.ts" ./scripts/claude-run.sh
#
#   # 交互模式
#   ./scripts/claude-run.sh
#
#   # 可选变量
#   MODEL=opus MAX_TURNS=5 PROMPT="..." ./scripts/claude-run.sh
#
# 变量            默认值      说明
# ──────────────────────────────────────────────
# PROXY_PORT      7048        AgentProxy 代理端口
# API_KEY         sk-upai     代理配置的 API key（任意值即可，代理会用自己配置的上游 key 转发）
# MODEL           haiku       Claude 模型名
# PROMPT          (空)        传入则非交互模式(-p)，否则交互模式
# MAX_TURNS       (空)        最大对话轮次
# APPEND_PROMPT   (空)        追加 system prompt
# WORKTREE        (空)        创建隔离 git worktree
#
# ⚠️ 注意事项：
#
# 1. CC Switch 冲突
#    ~/.claude/settings.json 的 env 段会把 ANTHROPIC_BASE_URL 强制指向
#    localhost:5000（CC Switch），导致环境变量被覆盖、请求不走 7048。
#    本脚本用 --setting-sources "project,local" 跳过 user settings 解决。
#    注意：--bare 模式不认环境变量，仍然走 CC Switch 的 5000 端口。
#
# 2. API Key
#    跳过 user settings 后，Claude CLI 失去 OAuth 认证，需要显式传
#    ANTHROPIC_API_KEY。当前默认 sk-upai 对应 ~/.agentproxy/config.json
#    里"慧星云" profile 的 key。代理原样转发此 key 到上游。
#
#    ⚠️ 代理必须在转发前删除 authorization 头（server/proxy.ts 里
#    delete headers.authorization），否则 Claude CLI 自带的
#    "authorization: Bearer PROXY_MANAGED" 会被一起转发，上游优先
#    读这个无效的 authorization 头导致 401，即使 x-api-key 是对的。
#
# 3. 不修改任何配置文件
#    本脚本纯靠环境变量 + CLI 参数，不改动 settings.json / config.json。
#
# 4. 日志文件删除
#    如果手动删除了 ~/.agentproxy/logs/ 下的日志文件，服务端仍持有
#    旧文件描述符，新日志会写到已删除的 inode（不可见）。需要重启
#    AgentProxy 服务才能创建新日志文件。
#
# ──────────────────────────────────────────────────────────────────

# ─── 固定配置 ────────────────────────────────────────────────────
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROXY_PORT="${PROXY_PORT:-7048}"
API_KEY="${API_KEY:-sk-upai}"
MODEL="${MODEL:-haiku}"

# ─── 可选变量 ────────────────────────────────────────────────────
PROMPT="${PROMPT:-}"
MAX_TURNS="${MAX_TURNS:-}"
APPEND_PROMPT="${APPEND_PROMPT:-}"
WORKTREE="${WORKTREE:-}"

# ─── 环境变量 ────────────────────────────────────────────────────
export ANTHROPIC_BASE_URL="http://localhost:${PROXY_PORT}"
export OPENAI_BASE_URL="http://localhost:${PROXY_PORT}/v1"
export ANTHROPIC_API_KEY="$API_KEY"

# ─── 构建命令 ────────────────────────────────────────────────────
args=(--setting-sources "project,local" --model "$MODEL")

[[ -n "$PROMPT" ]]        && args+=(-p "$PROMPT")
[[ -n "$MAX_TURNS" ]]     && args+=(--max-turns "$MAX_TURNS")
[[ -n "$APPEND_PROMPT" ]] && args+=(--append-system-prompt "$APPEND_PROMPT")
[[ -n "$WORKTREE" ]]      && args+=(-w "$WORKTREE")

# ─── 执行 ────────────────────────────────────────────────────────
cd "$PROJECT_DIR"

echo "🔀 代理: localhost:$PROXY_PORT  🤖 模型: $MODEL"
if [[ -n "$PROMPT" ]]; then
  echo "💬 ${PROMPT:0:80}..."
fi
echo "---"

exec claude "${args[@]}"
