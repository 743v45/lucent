#!/usr/bin/env bash
set -euo pipefail

# ──────────────────────────────────────────────────────────────────
# codex-run.sh — 通过 AgentProxy (7048) 调用 Codex CLI
# ──────────────────────────────────────────────────────────────────
#
# 用途：给 AgentProxy 项目本身做测试，请求经代理转发并记录到日志，
#       可在 Web UI (7049) 上查看完整的请求/响应数据。
#
# 用法：
#   # 非交互（最常用）
#   PROMPT="帮我 review server/proxy.ts" ./scripts/codex-run.sh
#
#   # 交互模式
#   ./scripts/codex-run.sh
#
#   # 可选变量
#   MODEL=o3-mini PROMPT="..." ./scripts/codex-run.sh
#
# 变量            默认值        说明
# ──────────────────────────────────────────────
# PROXY_PORT      7048        AgentProxy 代理端口
# API_KEY         sk-upai     代理配置的 API key
# MODEL           gpt-4o-mini Codex 模型名
# PROMPT          (空)        传入则 exec 模式，否则交互模式
# EPHEMERAL       (空)        设置则不持久化 session
# APPROVAL        never       审批策略 (never/on-request/untrusted)
#
# ⚠️ 前置条件：
#
# 1. Codex 认证配置
#    Codex 需要有效的 OpenAI API key。有两种配置方式：
#
#    方法 A：使用 codex login 命令
#      echo "YOUR_OPENAI_API_KEY" | codex login --with-api-key
#
#    方法 B：直接写入 auth.json
#      echo '{"auth_mode":"apikey","OPENAI_API_KEY":"YOUR_OPENAI_API_KEY"}' > ~/.codex/auth.json
#
#    ⚠️ 注意：OPENAI_API_KEY 环境变量对 Codex 的 WebSocket Responses API 无效
#    Codex 会优先读取 ~/.codex/auth.json 中的 key
#
# 2. AgentProxy OpenAI 配置
#    需要配置 AgentProxy 的 openai-chat 和 openai-responses profile：
#      curl -X PUT "http://localhost:7049/api/config/openai-chat/profiles/1" \
#        -H "Content-Type: application/json" \
#        -d '{"upstreamBaseUrl":"http://zhy1.dc.huixingyun.com:55627","apiKey":"sk-upai"}'
#      curl -X PUT "http://localhost:7049/api/config/openai-responses/profiles/1" \
#        -H "Content-Type: application/json" \
#        -d '{"upstreamBaseUrl":"http://zhy1.dc.huixingyun.com:55627","apiKey":"sk-upai"}'
#
# 3. 限制说明
#    Codex 使用 OpenAI Responses API 的 WebSocket 连接，
#    OPENAI_BASE_URL 环境变量对 WebSocket 端点无效，
#    Codex 会始终尝试连接 wss://api.openai.com/v1/responses。
#
#    因此，要让 Codex 通过 AgentProxy，需要：
#    - AgentProxy 支持 WebSocket 代理（当前未实现）
#    - 或者使用 Codex 的 HTTP 模式（如果存在）
#
#    当前脚本主要用于记录 Codex 的 HTTP 请求部分。
#
# ──────────────────────────────────────────────────────────────────

# ─── 固定配置 ────────────────────────────────────────────────────
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROXY_PORT="${PROXY_PORT:-7048}"
API_KEY="${API_KEY:-sk-upai}"
MODEL="${MODEL:-gpt-4o-mini}"
APPROVAL="${APPROVAL:-never}"

# ─── 可选变量 ────────────────────────────────────────────────────
PROMPT="${PROMPT:-}"
EPHEMERAL="${EPHEMERAL:-}"

# ─── 环境变量 ────────────────────────────────────────────────────
export OPENAI_BASE_URL="http://localhost:${PROXY_PORT}/v1"
export OPENAI_API_KEY="$API_KEY"

# ⚠️ 注意：Codex 的 WebSocket Responses API 不使用 OPENAI_BASE_URL
# 它会直接连接 wss://api.openai.com/v1/responses
# 只有 HTTP 请求部分会通过 AgentProxy

# ─── 检查认证配置 ────────────────────────────────────────────────
AUTH_FILE="$HOME/.codex/auth.json"
if [[ ! -f "$AUTH_FILE" ]] || [[ "$(jq -r '.OPENAI_API_KEY' "$AUTH_FILE" 2>/dev/null)" == "null" ]]; then
  echo "⚠️  未找到 Codex 认证配置或 API key 为空: $AUTH_FILE"
  echo "请运行以下命令配置认证："
  echo "  echo 'YOUR_OPENAI_API_KEY' | codex login --with-api-key"
  echo ""
  echo "或直接创建 auth.json："
  echo "  echo '{\"auth_mode\":\"apikey\",\"OPENAI_API_KEY\":\"YOUR_OPENAI_API_KEY\"}' > $AUTH_FILE"
  exit 1
fi

# ─── 构建命令 ────────────────────────────────────────────────────
if [[ -n "$PROMPT" ]]; then
  # 非交互模式 (exec)
  args=(exec "$PROMPT")
else
  # 交互模式
  args=()
fi

args+=(-m "$MODEL")
args+=(--approval "$APPROVAL")

[[ -n "$EPHEMERAL" ]] && args+=(--ephemeral)

# ─── 执行 ────────────────────────────────────────────────────────
cd "$PROJECT_DIR"

echo "🔀 代理: localhost:$PROXY_PORT  🤖 模型: $MODEL"
if [[ -n "$PROMPT" ]]; then
  echo "💬 ${PROMPT:0:80}..."
  echo "📋 模式: exec"
else
  echo "📋 模式: interactive"
fi
echo "---"

exec codex "${args[@]}"